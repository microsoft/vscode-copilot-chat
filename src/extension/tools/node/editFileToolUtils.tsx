/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from '@vscode/l10n';
import { realpath } from 'fs/promises';
import { homedir } from 'os';
import type { LanguageModelChat, PreparedToolInvocation } from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { OffsetLineColumnConverter } from '../../../platform/editing/common/offsetLineColumnConverter';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { findNotebook } from '../../../util/common/notebooks';
import * as glob from '../../../util/vs/base/common/glob';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { Schemas } from '../../../util/vs/base/common/network';
import { isMacintosh, isWindows } from '../../../util/vs/base/common/platform';
import { extUriBiasedIgnorePathCase, normalizePath, relativePath } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { Position as EditorPosition } from '../../../util/vs/editor/common/core/position';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { EndOfLine, Position, Range, TextEdit } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';

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
 * Converts text positions to line numbers (1-based).
 */
function positionsToLineNumbers(text: string, positions: number[]): number[] {
	if (positions.length === 0) return [];
	
	const lines = text.split('\n');
	let currentPos = 0;
	const lineNumbers: number[] = [];
	let positionIndex = 0;
	
	for (let lineIndex = 0; lineIndex < lines.length && positionIndex < positions.length; lineIndex++) {
		const isLastLine = lineIndex === lines.length - 1;
		const lineStart = currentPos;
		const lineEnd = currentPos + lines[lineIndex].length;
		
		// Helper function to check if position is within this line's content
		const isPositionInLine = (pos: number) => {
			return pos >= lineStart && pos <= lineEnd;
		};
		
		while (positionIndex < positions.length && isPositionInLine(positions[positionIndex])) {
			lineNumbers.push(lineIndex + 1); // 1-based line numbers
			positionIndex++;
		}
		
		currentPos += lines[lineIndex].length + (isLastLine ? 0 : 1);
	}
	
	return lineNumbers;
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
	| { text: string; type: 'multiple'; suggestion: string; matchPositions: number[]; strategy: 'exact' | 'fuzzy' | 'whitespace'; lineNumbers?: number[] }
);

/**
 * Enhanced version of findAndReplaceOne with more robust matching strategies
 * and better error information.
 *
 * @param text The source text to search in
 * @param oldStr The string to find and replace
 * @param newStr The replacement string
 * @param replaceAll Whether to replace all occurrences instead of throwing an error for multiple matches
 * @returns An object with the new text, match type, and additional match information
 */
export function findAndReplaceOne(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string,
	replaceAll: boolean = false,
): MatchResult {
	// Strategy 1: Try exact match first (fastest)
	const exactResult = tryExactMatch(text, oldStr, newStr, replaceAll);
	if (exactResult.type !== 'none') {
		return exactResult;
	}

	// Strategy 2: Try whitespace-flexible matching
	const whitespaceResult = tryWhitespaceFlexibleMatch(text, oldStr, newStr, eol, replaceAll);
	if (whitespaceResult.type !== 'none') {
		return whitespaceResult;
	}

	// Strategy 3: Try line-by-line fuzzy matching
	const fuzzyResult = tryFuzzyMatch(text, oldStr, newStr, eol, replaceAll);
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
function tryExactMatch(text: string, oldStr: string, newStr: string, replaceAll: boolean = false): MatchResult {
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
		if (replaceAll) {
			// Replace all occurrences from right to left to avoid position shifts
			let result = text;
			for (let i = matchPositions.length - 1; i >= 0; i--) {
				const idx = matchPositions[i];
				result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length);
			}
			return {
				text: result,
				type: 'exact',
				editPosition: matchPositions.map(idx => [idx, idx + oldStr.length]),
			};
		} else {
			const lineNumbers = positionsToLineNumbers(text, matchPositions);
			return {
				text,
				type: 'multiple',
				editPosition: matchPositions.map(idx => [idx, idx + oldStr.length]),
				strategy: 'exact',
				matchPositions,
				lineNumbers,
				suggestion: `Multiple exact matches found on lines ${lineNumbers.join(', ')}. Make your search string more specific or use replaceAll: true to replace all occurrences.`
			};
		}
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
function tryWhitespaceFlexibleMatch(text: string, oldStr: string, newStr: string, eol: string, replaceAll: boolean = false): MatchResult {
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
		if (replaceAll) {
			// Replace all occurrences from right to left to avoid position shifts
			let result = text;
			for (let i = matchedLines.length - 1; i >= 0; i--) {
				const startIdx = positions[i];
				const endIdx = convert.positionToOffset(new EditorPosition(matchedLines[i] + 1 + needle.length, 1));
				result = result.slice(0, startIdx) + newStr + eol + result.slice(endIdx);
			}
			return {
				text: result,
				type: 'whitespace',
				editPosition: matchedLines.map((match, i) => [positions[i], convert.positionToOffset(new EditorPosition(match + 1 + needle.length, 1))]),
			};
		} else {
			const lineNumbers = matchedLines.map(line => line + 1); // Convert to 1-based
			return {
				text,
				type: 'multiple',
				editPosition: [],
				matchPositions: positions,
				lineNumbers,
				suggestion: `Multiple matches found with flexible whitespace on lines ${lineNumbers.join(', ')}. Make your search string more unique or use replaceAll: true to replace all occurrences.`,
				strategy: 'whitespace',
			};
		}
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
function tryFuzzyMatch(text: string, oldStr: string, newStr: string, eol: string, replaceAll: boolean = false): MatchResult {
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
		if (replaceAll) {
			// Replace all occurrences from right to left to avoid position shifts
			let result = text;
			for (let i = matches.length - 1; i >= 0; i--) {
				const match = matches[i];
				const startIdx = match.index || 0;
				const endIdx = startIdx + match[0].length;
				result = result.slice(0, startIdx) + newStr + result.slice(endIdx);
			}
			return {
				text: result,
				type: 'fuzzy',
				editPosition: matches.map(match => [match.index || 0, (match.index || 0) + match[0].length]),
			};
		} else {
			const matchPositions = matches.map(match => match.index || 0);
			const lineNumbers = positionsToLineNumbers(text, matchPositions);
			return {
				text,
				type: 'multiple',
				editPosition: [],
				suggestion: `Multiple fuzzy matches found on lines ${lineNumbers.join(', ')}. Try including more context in your search string or use replaceAll: true to replace all occurrences.`,
				strategy: 'fuzzy',
				matchPositions,
				lineNumbers,
			};
		}
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

	let bestMatch = { startLine: -1, startOffset: 0, oldLength: 0, similarity: 0 };
	let startOffset = 0;

	// Sliding window approach to find the best matching section
	for (let i = 0; i <= lines.length - oldLines.length; i++) {
		let totalSimilarity = 0;
		let oldLength = 0;

		// Calculate similarity for each line in the window
		for (let j = 0; j < oldLines.length; j++) {
			const similarity = calculateSimilarity(oldLines[j], lines[i + j]);
			totalSimilarity += similarity;
			oldLength += lines[i + j].length;
		}

		const avgSimilarity = totalSimilarity / oldLines.length;
		if (avgSimilarity > threshold && avgSimilarity > bestMatch.similarity) {
			bestMatch = { startLine: i, startOffset, similarity: avgSimilarity, oldLength: oldLength + (oldLines.length - 1) * eol.length };
		}

		startOffset += lines[i].length + eol.length;
	}

	if (bestMatch.startLine === -1) {
		return { text, editPosition: [], type: 'none' };
	}

	// Replace the matched section
	const newLines = [
		...lines.slice(0, bestMatch.startLine),
		...newStr.split(eol),
		...lines.slice(bestMatch.startLine + oldLines.length)
	];

	return {
		text: newLines.join(eol),
		type: 'similarity',
		editPosition: [[bestMatch.startOffset, bestMatch.startOffset + bestMatch.oldLength]],
		similarity: bestMatch.similarity,
		suggestion: `Used similarity matching (${(bestMatch.similarity * 100).toFixed(1)}% similar). Verify the replacement.`
	};
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
	workspaceService: IWorkspaceService,
	notebookService: INotebookService,
	alternativeNotebookContent: IAlternativeNotebookContentService,
	languageModel: LanguageModelChat | undefined,
	replaceAll: boolean = false

): Promise<{ patch: Hunk[]; updatedFile: string; edits: TextEdit[] }> {
	let originalFile: string;
	let updatedFile: string;
	const edits: TextEdit[] = [];
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
			edits.push(TextEdit.insert(new Position(0, 0), new_string));
		} else {
			// Edit existing file case
			if (new_string === '') {
				// For empty new string, handle special deletion case
				const result = findAndReplaceOne(originalFile, old_string, new_string, eol, replaceAll);
				if (result.type === 'none') {
					// Try with newline appended if the original doesn't end with newline
					if (!old_string.endsWith(eol) && originalFile.includes(old_string + eol)) {
						updatedFile = originalFile.replace(old_string + eol, new_string);

						if (result.editPosition.length) {
							const [start, end] = result.editPosition[0];
							const range = new Range(document.positionAt(start), document.positionAt(end));
							edits.push(TextEdit.delete(range));
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

					// Handle multiple edits for replaceAll
					for (const [start, end] of result.editPosition) {
						const range = new Range(document.positionAt(start), document.positionAt(end));
						edits.push(TextEdit.delete(range));
					}
				}
			} else {
				// Normal replacement case using the enhanced matcher
				const result = findAndReplaceOne(originalFile, old_string, new_string, eol, replaceAll);

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

					// Handle multiple edits for replaceAll
					for (const [start, end] of result.editPosition) {
						const range = new Range(document.positionAt(start), document.positionAt(end));
						edits.push(TextEdit.replace(range, new_string));
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

		return { patch, updatedFile, edits };
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

			edits.push(TextEdit.insert(new Position(0, 0), new_string));
			return { patch, updatedFile, edits };
		}

		if (error instanceof EditError) {
			throw error;
		} else {
			throw new EditError(`Failed to edit file: ${error.message}`, 'unknownError');
		}
	}
}

const ALWAYS_CHECKED_EDIT_PATTERNS: Readonly<Record<string, boolean>> = {
	'**/.vscode/*.json': false,
};

const allPlatformPatterns = [homedir() + '/.*', homedir() + '/.*/**'];

// Path prefixes under which confirmation is unconditionally required
const platformConfirmationRequiredPaths = (
	isWindows
		? [process.env.APPDATA + '/**', process.env.LOCALAPPDATA + '/**']
		: isMacintosh
			? [homedir() + '/Library/**']
			: []
).concat(allPlatformPatterns).map(p => glob.parse(p));

const enum ConfirmationCheckResult {
	NoConfirmation,
	NoPermissions,
	Sensitive,
	SystemFile,
	OutsideWorkspace,
}

/**
 * Returns a function that returns whether a URI is approved for editing without
 * further user confirmation.
 */
function makeUriConfirmationChecker(configuration: IConfigurationService, workspaceService: IWorkspaceService, customInstructionsService: ICustomInstructionsService) {
	const patterns = configuration.getNonExtensionConfig<Record<string, boolean>>('chat.tools.edits.autoApprove');

	const checks = new ResourceMap<{ patterns: { pattern: glob.ParsedPattern; isApproved: boolean }[]; ignoreCasing: boolean }>();
	const getPatterns = (wf: URI) => {
		let arr = checks.get(wf);
		if (arr) {
			return arr;
		}

		const ignoreCasing = extUriBiasedIgnorePathCase.ignorePathCasing(wf);
		arr = { patterns: [], ignoreCasing };
		for (const obj of [patterns, ALWAYS_CHECKED_EDIT_PATTERNS]) {
			if (obj) {
				for (const [pattern, isApproved] of Object.entries(obj)) {
					arr.patterns.push({ pattern: glob.parse({ base: wf.fsPath, pattern: ignoreCasing ? pattern.toLowerCase() : pattern }), isApproved });
				}
			}
		}

		checks.set(wf, arr);
		return arr;
	};

	function checkUri(uri: URI) {
		const workspaceFolder = workspaceService.getWorkspaceFolder(uri);
		if (!workspaceFolder && !customInstructionsService.isExternalInstructionsFile(uri) && uri.scheme !== Schemas.untitled) {
			return ConfirmationCheckResult.OutsideWorkspace;
		}

		let ok = true;
		let fsPath = uri.fsPath;

		if (platformConfirmationRequiredPaths.some(p => p(fsPath))) {
			return ConfirmationCheckResult.SystemFile;
		}

		const { patterns, ignoreCasing } = getPatterns(workspaceFolder || URI.file('/'));
		if (ignoreCasing) {
			fsPath = fsPath.toLowerCase();
		}

		for (const { pattern, isApproved } of patterns) {
			if (isApproved !== ok && pattern(fsPath)) {
				ok = isApproved;
			}
		}

		return ok ? ConfirmationCheckResult.NoConfirmation : ConfirmationCheckResult.Sensitive;
	}

	return async (uri: URI) => {
		const toCheck = [normalizePath(uri)];
		if (uri.scheme === Schemas.file) {
			try {
				const linked = await realpath(uri.fsPath);
				if (linked !== uri.fsPath) {
					toCheck.push(URI.file(linked));
				}
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'EPERM') {
					return ConfirmationCheckResult.NoPermissions;
				}
				// Usually EPERM or ENOENT on the linkedFile
			}
		}

		return Math.max(...toCheck.map(checkUri));
	};
}

export async function createEditConfirmation(accessor: ServicesAccessor, uris: readonly URI[], asString: () => string): Promise<PreparedToolInvocation> {
	const checker = makeUriConfirmationChecker(accessor.get(IConfigurationService), accessor.get(IWorkspaceService), accessor.get(ICustomInstructionsService));
	const workspaceService = accessor.get(IWorkspaceService);
	const needsConfirmation = (await Promise.all(uris
		.map(async uri => ({ uri, reason: await checker(uri) }))
	)).filter(r => r.reason !== ConfirmationCheckResult.NoConfirmation);

	if (!needsConfirmation.length) {
		return { presentation: 'hidden' };
	}

	const fileParts = needsConfirmation.map(({ uri }) => {
		const wf = workspaceService.getWorkspaceFolder(uri);
		return '`' + (wf ? relativePath(wf, uri) : uri.fsPath) + '`';
	}).join(', ');

	let message: string;
	if (needsConfirmation.some(r => r.reason === ConfirmationCheckResult.NoPermissions)) {
		message = t`The model wants to edit files you don't have permission to modify (${fileParts}).`;
	} else if (needsConfirmation.some(r => r.reason === ConfirmationCheckResult.Sensitive)) {
		message = t`The model wants to edit sensitive files (${fileParts}).`;
	} else if (needsConfirmation.some(r => r.reason === ConfirmationCheckResult.OutsideWorkspace)) {
		message = t`The model wants to edit files outside of your workspace (${fileParts}).`;
	} else {
		message = t`The model wants to edit system files (${fileParts}).`;
	}

	return {
		confirmationMessages: {
			title: t('Allow edits to sensitive files?'),
			message: message + ' ' + t`Do you want to allow this?` + '\n\n' + asString(),
		},
		presentation: 'hiddenAfterComplete'
	};
}

/** Returns whether the file can be edited. This is true if the file exists or it's opened (e.g. untitled files) */
export function canExistingFileBeEdited(accessor: ServicesAccessor, uri: URI): Promise<boolean> {
	const workspace = accessor.get(IWorkspaceService);
	if (workspace.textDocuments.some(d => extUriBiasedIgnorePathCase.isEqual(d.uri, uri))) {
		return Promise.resolve(true);
	}

	const fileSystemService = accessor.get(IFileSystemService);
	return fileSystemService.stat(uri).then(() => true, () => false);
}


export function logEditToolResult(logService: ILogService, requestId: string | undefined, ...opts: {
	input: unknown;
	success: boolean;
	healed?: unknown | undefined;
}[]) {
	logService.debug(`[edit-tool:${requestId}] ${JSON.stringify(opts)}`);
}

export async function openDocumentAndSnapshot(accessor: ServicesAccessor, promptContext: IBuildPromptContext | undefined, uri: URI): Promise<NotebookDocumentSnapshot | TextDocumentSnapshot> {
	const notebookService = accessor.get(INotebookService);
	const workspaceService = accessor.get(IWorkspaceService);
	const alternativeNotebookContent = accessor.get(IAlternativeNotebookContentService);

	const previouslyEdited = promptContext?.turnEditedDocuments?.get(uri);
	if (previouslyEdited) {
		return previouslyEdited;
	}

	const isNotebook = notebookService.hasSupportedNotebooks(uri);
	if (isNotebook) {
		uri = findNotebook(uri, workspaceService.notebookDocuments)?.uri || uri;
	}
	return isNotebook ?
		await workspaceService.openNotebookDocumentAndSnapshot(uri, alternativeNotebookContent.getFormat(promptContext?.request?.model)) :
		await workspaceService.openTextDocumentAndSnapshot(uri);
}
