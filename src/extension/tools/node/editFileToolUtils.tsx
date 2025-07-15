/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import { OffsetLineColumnConverter } from '../../../platform/editing/common/offsetLineColumnConverter';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { URI } from '../../../util/vs/base/common/uri';
import { Position as EditorPosition } from '../../../util/vs/editor/common/core/position';
import { EndOfLine, Position, Range, WorkspaceEdit } from '../../../vscodeTypes';

// Simplified Hunk type for the patch
interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

/**
 * Base class for edit errors
 */
export class EditError extends Error {
	constructor(message: string, public readonly kindForTelemetry: string) {
		super(message);
	}
}

/**
 * Error thrown when no match is found for a string replacement
 */
export class NoMatchError extends EditError {
	constructor(message: string, public readonly file: string) {
		super(message, 'noMatchFound');
	}
}

/**
 * Error thrown when multiple matches are found for a string replacement
 */
export class MultipleMatchesError extends EditError {
	constructor(message: string, public readonly file: string) {
		super(message, 'multipleMatchesFound');
	}
}

/**
 * Error thrown when the edit would result in no changes
 */
export class NoChangeError extends EditError {
	constructor(message: string, public readonly file: string) {
		super(message, 'noChange');
	}
}

/**
 * Error thrown when there are issues with the content format
 */
export class ContentFormatError extends EditError {
	constructor(message: string, public readonly file: string) {
		super(message, 'contentFormatError');
	}
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calculates the similarity ratio between two strings using Levenshtein distance.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function calculateSimilarity(str1: string, str2: string): number {
	if (str1 === str2) { return 1.0; }
	if (str1.length === 0) { return 0.0; }
	if (str2.length === 0) { return 0.0; }

	// Calculate Levenshtein distance
	const matrix: number[][] = [];
	for (let i = 0; i <= str1.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= str2.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= str1.length; i++) {
		for (let j = 1; j <= str2.length; j++) {
			const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1, // deletion
				matrix[i][j - 1] + 1, // insertion
				matrix[i - 1][j - 1] + cost // substitution
			);
		}
	}

	const distance = matrix[str1.length][str2.length];
	const maxLength = Math.max(str1.length, str2.length);
	// Return similarity ratio (1 - normalized distance)
	return 1 - distance / maxLength;
}

interface MatchResultCommon {
	type: string;
	/** Replacement text */
	text: string;
	/** Array of [startIndex, endIndex] to replace in the file content */
	editPosition: [number, number][];
	/** Model suggestion to correct a fialing match */
	suggestion?: string;
}

/**
 * Type-safe union type for match results with discriminated unions
 */
type MatchResult = MatchResultCommon & (
	| { text: string; type: 'none'; suggestion?: string }
	| { text: string; type: 'exact' }
	| { text: string; type: 'fuzzy' }
	| { text: string; type: 'whitespace' }
	| { text: string; type: 'similarity'; suggestion: string; similarity: number }
	| { text: string; type: 'multiple'; suggestion: string; matchPositions: number[]; strategy: 'exact' | 'fuzzy' | 'whitespace' }
);

/**
 * Enhanced version of findAndReplaceOne with more robust matching strategies
 * and better error information.
 *
 * @param text The source text to search in
 * @param oldStr The string to find and replace
 * @param newStr The replacement string
 * @returns An object with the new text, match type, and additional match information
 */
export function findAndReplaceOne(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string,
): MatchResult {
	// Strategy 1: Try exact match first (fastest)
	const exactResult = tryExactMatch(text, oldStr, newStr);
	if (exactResult.type !== 'none') {
		return exactResult;
	}

	// Strategy 2: Try whitespace-flexible matching
	const whitespaceResult = tryWhitespaceFlexibleMatch(text, oldStr, newStr, eol);
	if (whitespaceResult.type !== 'none') {
		return whitespaceResult;
	}

	// Strategy 3: Try line-by-line fuzzy matching
	const fuzzyResult = tryFuzzyMatch(text, oldStr, newStr, eol);
	if (fuzzyResult.type !== 'none') {
		return fuzzyResult;
	}

	// Strategy 4: Try similarity-based matching as last resort
	const similarityResult = trySimilarityMatch(text, oldStr, newStr, eol);
	if (similarityResult.type !== 'none') {
		return similarityResult;
	}

	// No matches found with any strategy
	return {
		text,
		type: 'none',
		editPosition: [],
		suggestion: `Try making your search string more specific or checking for whitespace/formatting differences.`
	};
}

/**
 * Tries to find an exact match of oldStr in text.
 */
function tryExactMatch(text: string, oldStr: string, newStr: string): MatchResult {
	const matchPositions: number[] = [];
	for (let searchIdx = 0; ;) {
		const idx = text.indexOf(oldStr, searchIdx);
		if (idx === -1) { break; }
		matchPositions.push(idx);
		searchIdx = idx + oldStr.length;
	}
	if (matchPositions.length === 0) {
		return { text, editPosition: [], type: 'none' };
	}

	// Check for multiple exact occurrences.
	if (matchPositions.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition: matchPositions.map(idx => [idx, idx + oldStr.length]),
			strategy: 'exact',
			matchPositions,
			suggestion: "Multiple exact matches found. Make your search string more specific."
		};
	}
	// Exactly one exact match found.
	const firstExactIdx = matchPositions[0];
	const replaced = text.slice(0, firstExactIdx) + newStr + text.slice(firstExactIdx + oldStr.length);
	return {
		text: replaced,
		type: 'exact',
		editPosition: [[firstExactIdx, firstExactIdx + oldStr.length]],
	};
}

/**
 * Tries to match using flexible whitespace handling.
 */
function tryWhitespaceFlexibleMatch(text: string, oldStr: string, newStr: string, eol: string): MatchResult {
	const haystack = text.split(eol).map(line => line.trim());
	const needle = oldStr.trim().split(eol).map(line => line.trim());
	needle.push(''); // trailing newline to match until the end of a line

	const convert = new OffsetLineColumnConverter(text);
	const matchedLines: number[] = [];
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (haystack.slice(i, i + needle.length).join('\n') === needle.join('\n')) {
			matchedLines.push(i);
			i += needle.length - 1;
		}
	}
	if (matchedLines.length === 0) {
		return {
			text,
			editPosition: [],
			type: 'none',
			suggestion: 'No whitespace-flexible match found.'
		};
	}

	const positions = matchedLines.map(match => convert.positionToOffset(new EditorPosition(match + 1, 1)));

	if (matchedLines.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition: [],
			matchPositions: positions,
			suggestion: "Multiple matches found with flexible whitespace. Make your search string more unique.",
			strategy: 'whitespace',
		};
	}

	// Exactly one whitespace-flexible match found
	const startIdx = positions[0];
	const endIdx = convert.positionToOffset(new EditorPosition(matchedLines[0] + 1 + needle.length, 1));
	const replaced = text.slice(0, startIdx) + newStr + eol + text.slice(endIdx);
	return {
		text: replaced,
		editPosition: [[startIdx, endIdx]],
		type: 'whitespace',
	};
}

/**
 * Tries to match using the traditional fuzzy approach with line-by-line matching.
 */
function tryFuzzyMatch(text: string, oldStr: string, newStr: string, eol: string): MatchResult {
	// Handle trailing newlines
	const hasTrailingLF = oldStr.endsWith(eol);
	if (hasTrailingLF) {
		oldStr = oldStr.slice(0, -eol.length);
	}

	// Build a regex pattern where each line is matched exactly
	// but allows for trailing spaces/tabs and flexible newline formats
	const lines = oldStr.split(eol);
	const pattern = lines
		.map((line, i) => {
			const escaped = escapeRegex(line);
			return i < lines.length - 1 || hasTrailingLF
				? `${escaped}[ \\t]*\\r?\\n`
				: `${escaped}[ \\t]*`;
		})
		.join('');
	const regex = new RegExp(pattern, 'g');

	const matches = Array.from(text.matchAll(regex));
	if (matches.length === 0) {
		return {
			text,
			editPosition: [],
			type: 'none',
			suggestion: 'No fuzzy match found.'
		};
	}
	if (matches.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition: [],
			suggestion: "Multiple fuzzy matches found. Try including more context in your search string.",
			strategy: 'fuzzy',
			matchPositions: matches.map(match => match.index || 0),
		};
	}

	// Exactly one fuzzy match found
	const match = matches[0];
	const startIdx = match.index || 0;
	const endIdx = startIdx + match[0].length;
	const replaced = text.slice(0, startIdx) + newStr + text.slice(endIdx);
	return {
		text: replaced,
		type: 'fuzzy',
		editPosition: [[startIdx, endIdx]],
	};
}

/**
 * Tries to match based on overall string similarity as a last resort.
 * Only works for relatively small strings to avoid performance issues.
 */
function trySimilarityMatch(text: string, oldStr: string, newStr: string, eol: string, threshold: number = 0.95): MatchResult {
	// Skip similarity matching for very large strings or too many lines
	if (oldStr.length > 1000 || oldStr.split(eol).length > 20) {
		return { text, editPosition: [], type: 'none' };
	}

	const lines = text.split(eol);
	const oldLines = oldStr.split(eol);

	// Don't try similarity matching for very large files
	if (lines.length > 1000) {
		return { text, editPosition: [], type: 'none' };
	}

	let bestMatch = { index: -1, similarity: 0, length: 0 };

	// Sliding window approach to find the best matching section
	for (let i = 0; i <= lines.length - oldLines.length; i++) {
		let totalSimilarity = 0;

		// Calculate similarity for each line in the window
		for (let j = 0; j < oldLines.length; j++) {
			const similarity = calculateSimilarity(oldLines[j], lines[i + j]);
			totalSimilarity += similarity;
		}

		const avgSimilarity = totalSimilarity / oldLines.length;
		if (avgSimilarity > threshold && avgSimilarity > bestMatch.similarity) {
			bestMatch = { index: i, similarity: avgSimilarity, length: oldLines.length };
		}
	}

	if (bestMatch.index !== -1) {
		// Found a match with similarity above the threshold
		const startIndex = bestMatch.index;

		// Replace the matched section
		const newLines = [...lines];
		newLines.splice(startIndex, bestMatch.length, ...newStr.split(eol));

		return {
			text: newLines.join(eol),
			type: 'similarity',
			editPosition: [[startIndex, startIndex + bestMatch.length]],
			similarity: bestMatch.similarity,
			suggestion: `Used similarity matching (${(bestMatch.similarity * 100).toFixed(1)}% similar). Verify the replacement.`
		};
	}

	return { text, editPosition: [], type: 'none' };
}

// Function to generate a simple patch
function getPatch({ fileContents, oldStr, newStr }: { fileContents: string; oldStr: string; newStr: string }): Hunk[] {
	// Simplified patch generation - in a real implementation this would generate proper diff hunks
	return [{
		oldStart: 1,
		oldLines: (oldStr.match(/\n/g) || []).length + 1,
		newStart: 1,
		newLines: (newStr.match(/\n/g) || []).length + 1,
		lines: []
	}];
}

// Apply string edit function
export async function applyEdit(
	uri: URI,
	old_string: string,
	new_string: string,
	workspaceEdit: WorkspaceEdit,
	workspaceService: IWorkspaceService,
	notebookService: INotebookService,
	alternativeNotebookContent: IAlternativeNotebookContentService,
	languageModel: LanguageModelChat | undefined

): Promise<{ patch: Hunk[]; updatedFile: string }> {
	let originalFile: string;
	let updatedFile: string;
	const filePath = uri.toString();

	try {
		// Use VS Code workspace API to get the document content
		const document = notebookService.hasSupportedNotebooks(uri) ?
			await workspaceService.openNotebookDocumentAndSnapshot(uri, alternativeNotebookContent.getFormat(languageModel)) :
			await workspaceService.openTextDocumentAndSnapshot(uri);
		originalFile = document.getText();

		const eol = document instanceof TextDocumentSnapshot && document.eol === EndOfLine.CRLF ? '\r\n' : '\n';
		old_string = old_string.replace(/\r?\n/g, eol);
		new_string = new_string.replace(/\r?\n/g, eol);

		if (old_string === '') {
			if (originalFile !== '') {
				// If the file already exists and we're creating a new file with empty old_string
				throw new ContentFormatError('File already exists. Please provide a non-empty old_string for replacement.', filePath);
			}
			// Create new file case
			updatedFile = new_string;
			workspaceEdit.insert(uri, new Position(0, 0), new_string);
		} else {
			// Edit existing file case
			if (new_string === '') {
				// For empty new string, handle special deletion case
				const result = findAndReplaceOne(originalFile, old_string, new_string, eol);
				if (result.type === 'none') {
					// Try with newline appended if the original doesn't end with newline
					if (!old_string.endsWith(eol) && originalFile.includes(old_string + eol)) {
						updatedFile = originalFile.replace(old_string + eol, new_string);

						if (result.editPosition.length) {
							const [start, end] = result.editPosition[0];
							const range = new Range(document.positionAt(start), document.positionAt(end));
							workspaceEdit.delete(uri, range);
						}
					} else {
						const suggestion = result?.suggestion || 'The string to replace must match exactly.';
						throw new NoMatchError(
							`Could not find matching text to replace. ${suggestion}`,
							filePath
						);
					}
				} else if (result.type === 'multiple') {
					const suggestion = result?.suggestion || 'Please provide a more specific string.';
					throw new MultipleMatchesError(
						`Multiple matches found for the text to replace. ${suggestion}`,
						filePath
					);
				} else {
					updatedFile = result.text;

					if (result.editPosition.length) {
						const [start, end] = result.editPosition[0];
						const range = new Range(document.positionAt(start), document.positionAt(end));
						workspaceEdit.delete(uri, range);
					}
				}
			} else {
				// Normal replacement case using the enhanced matcher
				const result = findAndReplaceOne(originalFile, old_string, new_string, eol);

				if (result.type === 'none') {
					const suggestion = result?.suggestion || 'The string to replace must match exactly or be a valid fuzzy match.';
					throw new NoMatchError(
						`Could not find matching text to replace. ${suggestion}`,
						filePath
					);
				} else if (result.type === 'multiple') {
					const suggestion = result?.suggestion || 'Please provide a more specific string.';
					throw new MultipleMatchesError(
						`Multiple matches found for the text to replace. ${suggestion}`,
						filePath
					);
				} else {
					updatedFile = result.text;

					if (result.editPosition.length) {
						const [start, end] = result.editPosition[0];
						const range = new Range(document.positionAt(start), document.positionAt(end));
						workspaceEdit.replace(uri, range, new_string);
					}

					// If we used similarity matching, add a warning
					if (result.type === 'similarity' && result?.similarity) {
						console.warn(`Used similarity matching with ${(result.similarity * 100).toFixed(1)}% confidence. Verify the result is correct.`);
					}
				}
			}

			if (updatedFile === originalFile) {
				throw new NoChangeError(
					'Original and edited file match exactly. Failed to apply edit. Use the ${ToolName.ReadFile} tool to re-read the file and and determine the correct edit.',
					filePath
				);
			}
		}

		// Generate a simple patch
		const patch = getPatch({
			fileContents: originalFile,
			oldStr: originalFile,
			newStr: updatedFile,
		});

		return { patch, updatedFile };
	} catch (error) {
		// If the file doesn't exist and we're creating a new file with empty oldString
		if (old_string === '' && error.code === 'ENOENT') {
			originalFile = '';
			updatedFile = new_string;

			const patch = getPatch({
				fileContents: originalFile,
				oldStr: originalFile,
				newStr: updatedFile,
			});

			return { patch, updatedFile };
		}

		if (error instanceof EditError) {
			throw error;
		} else {
			throw new EditError(`Failed to edit file: ${error.message}`, 'unknownError');
		}
	}
}
