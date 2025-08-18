/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @fileoverview
 * This is the main class for using Elidable Texts,
 * a way to represent a larger, possibly multimodal document
 * to be used as prompt to an LLM.
 *
 * That document will need to be shortened to fit into a token budget.
 * Elidable Texts shorten it by dropping the least relevant lines,
 * and replacing them by ellipses (`[...]`).
 *
 * A typical way of using this class is to
 * - create an ElidableText from a some inputs,
 * - then call `makePrompt` to get a prompt that fits into a token budget.
 *
 * Like this:
 * ```
 * const question = new ElidableText([
 *   [`Could you look over Albert's PR and check whether we need to add tests for that one file?`, 0.5],
 *   [`They made the following changes to file ${this.filename} (in git diff format):`, 0.9],
 *   [this.diff, 0.7], // this.diff is an already constructed ElidableText
 *   [`The file now looks like this:`, 0.95],
 *   [documentWithLanguage, 0.8],
 *   [`Should I write tests for that?`, 1],
 * ]);
 * const prompt = question.makePrompt(1000); // makes sure no more than 1000 tokens
 * ```
 */

import { DocumentInfo } from '../../common/prompt';
import { getTokenizer, Tokenizer } from '../tokenization/api';
import { elidableTextForSourceCode } from './fromSourceCode';
import { LineWithValueAndCost } from './lineWithValueAndCost';

type InterpretableAsElidableText = string | ElidableText | DocumentInfo;
type elidableTextStrategy = 'removeLeastDesirable' | 'removeLeastBangForBuck';
type elidableTextOrientation = 'topToBottom' | 'bottomToTop';
type valueWithIndex = { value: number; originalIndex: number };

interface ElidedText {
	getText: () => string;
	getLines: () => LineWithValueAndCost[];
}

export class ElidableText {
	lines: LineWithValueAndCost[] = [];

	/**
	 * Create a text from a list of chunks, which can be strings or ElidableTexts.
	 * Supplying a number to the chunk corresponds to a priority.
	 * If the chunk is already elidable, the priorities are multiplied.
	 *
	 * If x is an ElidableText, then ElidableText(x) is the same as x.
	 * @param chunks
	 */
	constructor(
		chunks: (InterpretableAsElidableText | [InterpretableAsElidableText, number])[],
		private readonly metadata?: Map<string, unknown>,
		private readonly tokenizer: Tokenizer = getTokenizer()
	) {
		const lines: LineWithValueAndCost[] = [];
		for (const chunk of chunks) {
			// if array, take the second element as priority
			const value = Array.isArray(chunk) ? chunk[1] : 1;
			const input = Array.isArray(chunk) ? chunk[0] : chunk;
			if (typeof input === 'string') {
				input
					.split('\n')
					.forEach(line =>
						lines.push(
							new LineWithValueAndCost(
								line,
								value,
								tokenizer.tokenLength(line + '\n'),
								'strict',
								this.metadata
							)
						)
					);
			} else if (input instanceof ElidableText) {
				input.lines.forEach(line => lines.push(line.copy().adjustValue(value)));
			} else if ('source' in input && 'languageId' in input) {
				elidableTextForSourceCode(input).lines.forEach(line => lines.push(line.copy().adjustValue(value)));
			}
		}
		this.lines = lines;
	}

	adjust(multiplier: number): void {
		this.lines.forEach(line => line.adjustValue(multiplier));
	}

	/** Change the cost of lines according to a specified function; e.g. to take into account different tokenziers */
	recost(coster = (x: string) => getTokenizer().tokenLength(x + '\n')): void {
		this.lines.forEach(line => line.recost(coster));
	}

	/**
	 * Elides lines to make the text fit into a token budget.
	 * This is done by dropping the least desirable lines.
	 * @param maxTokens The maximum number of tokens to allow.
	 * @param ellipsis The string to use for ellipses.
	 * @param indentEllipses If true, indents ellipses with the minimum indentation of the elided lines.
	 * @param strategy "removeLeastDesirable" will greedily remove undesirable lines,
	 * "removeLeastBangForBuck" will remove the line that has the lowest value/cost ratio.
	 * The former is more likely to elide continguous blocks and thus often feels more natural.
	 * The latter can be more frugal by being less tempted to elide things like single whitespace lines.
	 * @param tokenizer The tokenizer to use for tokenizing the prompt.
	 */
	elide(
		maxTokens: number,
		ellipsis = '[...]',
		indentEllipses = true,
		strategy: elidableTextStrategy = 'removeLeastDesirable',
		tokenizer: Tokenizer = this.tokenizer,
		orientation: elidableTextOrientation = 'topToBottom'
	): ElidedText {
		if (tokenizer.tokenLength(ellipsis + '\n') > maxTokens) {
			throw new Error('maxTokens must be larger than the ellipsis length');
		}

		const { lines, totalCost, priorityQueue } = initializeElisionContext(this.lines, strategy);

		// If the total cost is already within the limit, return early
		if (totalCost <= maxTokens) {
			return produceElidedText(lines);
		}

		sortPriorityQueue(priorityQueue, orientation);

		// Initialize needed variables
		let currentTotalCost = totalCost;

		while (currentTotalCost > maxTokens && priorityQueue.length > 0) {
			// Extract the minimum element (least desirable)
			const leastDesirableLineIndex = priorityQueue.shift()!.originalIndex;

			const leastDesirableLine = lines[leastDesirableLineIndex];
			// Skip if this index was already removed (could happen with chunk removal)
			if (leastDesirableLine.markedForRemoval) { continue; }

			// Calculate indentation for the ellipsis (if enabled)
			const indentation = indentEllipses ? getClosestIndentation(lines, leastDesirableLineIndex) : '';

			// Create and insert the ellipsis
			const newEllipsis = getNewEllipsis(indentation, ellipsis, tokenizer, leastDesirableLine);

			// Replace the least desirable line with the new ellipsis
			lines[leastDesirableLineIndex] = newEllipsis;
			// Update total cost (subtract the line being removed)
			currentTotalCost -= leastDesirableLine.cost;
			// Add the cost of the new ellipsis
			currentTotalCost += newEllipsis.cost;

			// Remove adjacent ellipses to avoid duplication
			const nextIndex = leastDesirableLineIndex + 1;
			if (nextIndex < lines.length) {
				const nextLine = lines[nextIndex];
				if (isEllipsis(nextLine, ellipsis)) {
					currentTotalCost -= nextLine.cost;
					nextLine.markedForRemoval = true;
				}
			}

			const prevIndex = leastDesirableLineIndex - 1;
			if (prevIndex >= 0) {
				const prevLine = lines[prevIndex];
				if (isEllipsis(prevLine, ellipsis)) {
					currentTotalCost -= prevLine.cost;
					prevLine.markedForRemoval = true;
				}
			}
		}

		if (currentTotalCost > maxTokens) {
			// If nothing fits, return ellipses only
			return produceElidedText([getNewEllipsis('', ellipsis, tokenizer)]);
		}

		// Remove all lines that were marked for removal
		const filteredLines = lines.filter(line => !line.markedForRemoval);

		// Remove any adjacent ellipses
		for (let i = filteredLines.length - 1; i > 0; i--) {
			if (isEllipsis(filteredLines[i], ellipsis) && isEllipsis(filteredLines[i - 1], ellipsis)) {
				filteredLines.splice(i, 1);
			}
		}

		return produceElidedText(filteredLines);
	}
}

// Helper functions
function getIndentation(line: LineWithValueAndCost | undefined): string {
	return line?.text.match(/^\s*/)?.[0] ?? '';
}

function isEllipsis(line: LineWithValueAndCost | undefined, ellipsis: string): boolean {
	return line?.text.trim() === ellipsis.trim();
}

function produceElidedText(lines: LineWithValueAndCost[]): ElidedText {
	return {
		getText: () => lines.map(line => line.text).join('\n'),
		getLines: () => lines,
	};
}

function initializeElisionContext(originalLines: LineWithValueAndCost[], strategy: elidableTextStrategy) {
	// Initial setup with a single iteration through the lines
	let totalCost = 0;
	const priorityQueue: valueWithIndex[] = [];
	const lines = originalLines.map((l, i) => {
		// Create a copy of the line to avoid modifying the original
		const line = l.copy();

		// Adjust the value if needed
		if (strategy === 'removeLeastBangForBuck') {
			line.adjustValue(1 / line.cost);
		}

		// Use the loop to compute needed values
		totalCost += line.cost;

		// Add the line to the queue
		priorityQueue.push({
			originalIndex: i,
			value: line.value,
		});

		return line;
	});

	return {
		lines,
		totalCost,
		priorityQueue,
	};
}

function sortPriorityQueue(priorityQueue: valueWithIndex[], orientation: elidableTextOrientation): void {
	priorityQueue.sort((a, b) => {
		if (a.value !== b.value) { return a.value - b.value; }
		return orientation === 'bottomToTop' ? b.originalIndex - a.originalIndex : a.originalIndex - b.originalIndex;
	});
}

function getClosestIndentation(lines: readonly LineWithValueAndCost[], leastDesirableLineIndex: number): string {
	let indentation = '';
	for (let i = leastDesirableLineIndex; i >= 0; i--) {
		const line = lines[i];
		if (line.markedForRemoval) { continue; } // Skip lines that are marked for removal
		if (line.text.trim() !== '') {
			indentation = getIndentation(line);
			break;
		}
	}

	return indentation;
}

function getNewEllipsis(
	indentation: string,
	ellipsis: string,
	tokenizer: Tokenizer,
	leastDesirableLine?: LineWithValueAndCost
) {
	const insert = indentation + ellipsis;
	const newEllipsis = new LineWithValueAndCost(
		insert,
		Infinity,
		tokenizer.tokenLength(insert + '\n'),
		'loose',
		leastDesirableLine?.metadata
	);

	return newEllipsis;
}
