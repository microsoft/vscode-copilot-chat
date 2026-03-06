/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptingStrategy } from '../../src/platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { ITelemetryRow } from './parseCsv';

export interface IGeneratedResponse {
	readonly assistant: string;
	readonly source: 'oracle' | 'model';
}

export function offsetToLineNumber(content: string, offset: number): number {
	let line = 0;
	const clampedOffset = Math.min(offset, content.length);
	for (let i = 0; i < clampedOffset; i++) {
		if (content[i] === '\n') {
			line++;
		}
	}
	return line;
}

/**
 * Apply oracle edits (offset-based) to document content.
 * Edits are sorted by offset descending so earlier positions remain valid.
 */
export function applyEditsToContent(
	content: string,
	edits: readonly (readonly [start: number, endEx: number, text: string])[],
): string {
	const sorted = [...edits].sort((a, b) => b[0] - a[0]);
	let result = content;
	for (const [start, endEx, text] of sorted) {
		result = result.substring(0, start) + text + result.substring(endEx);
	}
	return result;
}

/**
 * Split content into lines (keeping the line content without line endings).
 */
function splitLines(content: string): string[] {
	return content.split(/\r?\n/);
}

/**
 * Format oracle edits as PatchBased02 custom diff patches.
 * Applies all edits to get the final document, then does a line-level diff
 * and groups consecutive changed lines into `filename:linenum\n-old\n+new` patches.
 */
export function formatAsCustomDiffPatch(
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
	docContent: string,
	filePath: string,
): string {
	const modifiedContent = applyEditsToContent(docContent, oracleEdits);

	const oldLines = splitLines(docContent);
	const newLines = splitLines(modifiedContent);

	const patches: string[] = [];
	const maxLen = Math.max(oldLines.length, newLines.length);

	let i = 0;
	while (i < maxLen) {
		const oldLine = i < oldLines.length ? oldLines[i] : undefined;
		const newLine = i < newLines.length ? newLines[i] : undefined;

		if (oldLine === newLine) {
			i++;
			continue;
		}

		// Collect the full run of changed lines
		const startLine = i;
		const removedLines: string[] = [];
		const addedLines: string[] = [];

		// Simple approach: collect all consecutive differing lines
		while (i < maxLen) {
			const ol = i < oldLines.length ? oldLines[i] : undefined;
			const nl = i < newLines.length ? newLines[i] : undefined;

			if (ol === nl) {
				break;
			}

			if (ol !== undefined) {
				removedLines.push(ol);
			}
			if (nl !== undefined) {
				addedLines.push(nl);
			}
			i++;
		}

		// PatchBased02 handler requires both removed and added lines
		if (removedLines.length > 0 && addedLines.length > 0) {
			patches.push([
				`${filePath}:${startLine}`,
				...removedLines.map(l => `-${l}`),
				...addedLines.map(l => `+${l}`),
			].join('\n'));
		} else if (removedLines.length > 0) {
			patches.push([
				`${filePath}:${startLine}`,
				...removedLines.map(l => `-${l}`),
				`+`,
			].join('\n'));
		} else if (addedLines.length > 0) {
			// Pure insertion — use previous line as anchor
			const anchorLine = startLine > 0 ? oldLines[startLine - 1] : '';
			patches.push([
				`${filePath}:${Math.max(0, startLine - 1)}`,
				`-${anchorLine}`,
				`+${anchorLine}`,
				...addedLines.map(l => `+${l}`),
			].join('\n'));
		}
	}

	return patches.join('\n');
}

/**
 * Parse the edit window content from a generated user prompt.
 * Looks for content between `<|code_to_edit|>` and `<|/code_to_edit|>` tags.
 */
export function parseEditWindowFromPrompt(userPrompt: string): {
	/** The raw lines between the tags (may include line numbers) */
	lines: string[];
	/** Number of lines in the edit window */
	lineCount: number;
} | undefined {
	const startTag = '<|code_to_edit|>';
	const endTag = '<|/code_to_edit|>';

	const startIdx = userPrompt.indexOf(startTag);
	const endIdx = userPrompt.indexOf(endTag);

	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
		return undefined;
	}

	const windowContent = userPrompt.substring(startIdx + startTag.length, endIdx);
	const lines = windowContent.split('\n');

	// Trim leading/trailing empty lines from tag placement
	while (lines.length > 0 && lines[0].trim() === '') {
		lines.shift();
	}
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}

	return { lines, lineCount: lines.length };
}

/**
 * Format oracle edits as Xtab275 edit-window content.
 * Applies oracle edits and re-extracts the edit window lines,
 * adjusting for line count changes within the window.
 */
export function formatAsEditWindowOnly(
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
	docContent: string,
	editWindowStartLine: number,
	editWindowLineCount: number,
): string {
	const editWindowEndLine = editWindowStartLine + editWindowLineCount;

	const modifiedContent = applyEditsToContent(docContent, oracleEdits);
	const modifiedLines = splitLines(modifiedContent);

	// Calculate net line change from edits overlapping the window
	let netLineChange = 0;
	for (const [start, endEx, text] of oracleEdits) {
		const editStartLine = offsetToLineNumber(docContent, start);
		const editEndLine = offsetToLineNumber(docContent, endEx);

		// Only count edits that overlap with the edit window
		if (editStartLine < editWindowEndLine && editEndLine >= editWindowStartLine) {
			const oldLineCount = splitLines(docContent.substring(start, endEx)).length;
			const newLineCount = text.length > 0 ? splitLines(text).length : 0;
			const effectiveOldCount = (endEx - start) === 0 ? 0 : oldLineCount;
			netLineChange += newLineCount - effectiveOldCount;
		}
	}

	// Extract the edit window from modified document
	const newEndLine = Math.min(editWindowEndLine + netLineChange, modifiedLines.length);
	const windowLines = modifiedLines.slice(editWindowStartLine, newEndLine);

	return windowLines.join('\n');
}

/**
 * Find the edit window start line by matching the edit window content from the
 * prompt against the document content.
 */
export function findEditWindowStartLine(
	docContent: string,
	editWindowLines: string[],
): number {
	if (editWindowLines.length === 0) {
		return 0;
	}

	const docLines = splitLines(docContent);

	// Strip line numbers from edit window lines (format: "N| content")
	const cleanedWindowLines = editWindowLines.map(stripLineNumber);

	// Also strip <|cursor|> tag for matching
	const cursorTag = '<|cursor|>';
	const matchLines = cleanedWindowLines.map(l => l.replace(cursorTag, ''));

	// Find the first line of the edit window in the document
	const firstWindowLine = matchLines[0];
	for (let i = 0; i <= docLines.length - matchLines.length; i++) {
		if (docLines[i] === firstWindowLine) {
			// Check if all subsequent lines match
			let allMatch = true;
			for (let j = 1; j < matchLines.length; j++) {
				if (docLines[i + j] !== matchLines[j]) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) {
				return i;
			}
		}
	}

	// Fallback: try to extract line number from the first edit window line
	const lineNumMatch = editWindowLines[0].match(/^(\d+)\| /);
	if (lineNumMatch) {
		return parseInt(lineNumMatch[1], 10) - 1; // Convert 1-based to 0-based
	}

	return 0;
}

function stripLineNumber(line: string): string {
	const match = line.match(/^\d+\| /);
	if (match) {
		return line.substring(match[0].length);
	}
	return line;
}

/**
 * Generate the assistant response for a training sample.
 *
 * Only PatchBased02 and Xtab275 strategies are supported. The response cannot
 * be generated by the existing NES response pipeline because we need to format
 * the **oracle edit** (what the user actually typed), not a model prediction.
 * The NES pipeline formats model output; here we format ground-truth edits
 * in the same format the model is expected to produce.
 */
export function generateResponse(
	strategy: PromptingStrategy,
	responseSource: 'oracle' | 'model',
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[] | undefined,
	docContent: string,
	filePath: string,
	userPrompt: string,
	row: ITelemetryRow,
): IGeneratedResponse | { error: string } {
	if (responseSource === 'model') {
		return {
			assistant: row.modelResponse,
			source: 'model',
		};
	}

	if (!oracleEdits || oracleEdits.length === 0) {
		return { error: 'No oracle edits available for oracle response source' };
	}

	if (strategy === PromptingStrategy.PatchBased02 || strategy === PromptingStrategy.PatchBased01 || strategy === PromptingStrategy.PatchBased) {
		const assistant = formatAsCustomDiffPatch(oracleEdits, docContent, filePath);
		if (!assistant) {
			return { error: 'formatAsCustomDiffPatch produced empty result' };
		}
		return { assistant, source: 'oracle' };
	}

	if (strategy === PromptingStrategy.Xtab275 || strategy === PromptingStrategy.XtabAggressiveness || strategy === PromptingStrategy.Xtab275Aggressiveness) {
		const editWindow = parseEditWindowFromPrompt(userPrompt);
		if (!editWindow) {
			return { error: 'Could not parse edit window from prompt (no <|code_to_edit|> tags found)' };
		}

		const startLine = findEditWindowStartLine(docContent, editWindow.lines);
		const assistant = formatAsEditWindowOnly(oracleEdits, docContent, startLine, editWindow.lineCount);
		return { assistant, source: 'oracle' };
	}

	return { error: `Unsupported strategy for oracle response: ${strategy}. Supported: patchBased02, xtab275` };
}

export interface IResponseGenerationInput {
	readonly index: number;
	readonly oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[] | undefined;
	readonly docContent: string;
	readonly filePath: string;
	readonly userPrompt: string;
	readonly row: ITelemetryRow;
}

export function generateAllResponses(
	strategy: PromptingStrategy,
	responseSource: 'oracle' | 'model',
	inputs: readonly IResponseGenerationInput[],
): {
	responses: { index: number; response: IGeneratedResponse }[];
	errors: { index: number; error: string }[];
} {
	const responses: { index: number; response: IGeneratedResponse }[] = [];
	const errors: { index: number; error: string }[] = [];

	for (const input of inputs) {
		const result = generateResponse(
			strategy, responseSource,
			input.oracleEdits, input.docContent, input.filePath,
			input.userPrompt, input.row,
		);
		if ('error' in result) {
			errors.push({ index: input.index, error: result.error });
		} else {
			responses.push({ index: input.index, response: result });
		}
	}

	return { responses, errors };
}
