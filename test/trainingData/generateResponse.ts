/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetryRow } from './parseCsv';

/**
 * Result of response generation for a single training sample.
 */
export interface IGeneratedResponse {
	/** The assistant message (formatted response) */
	readonly assistant: string;
	/** Which source was used: oracle (user's actual edit) or model (original model output) */
	readonly source: 'oracle' | 'model';
}

// ---------------------------------------------------------------------------
// Core utilities
// ---------------------------------------------------------------------------

/**
 * Convert a character offset to a 0-based line number within a document.
 */
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
 * Edits are applied in reverse offset order to preserve positions.
 */
export function applyEditsToContent(
	content: string,
	edits: readonly (readonly [start: number, endEx: number, text: string])[],
): string {
	// Sort edits by start offset descending so we can apply from end to start
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

// ---------------------------------------------------------------------------
// PatchBased02 (CustomDiffPatch) formatter
// ---------------------------------------------------------------------------

/**
 * Format oracle edits as PatchBased02 custom diff patches.
 *
 * Instead of converting each individual keystroke to a patch, we:
 * 1. Apply ALL oracle edits to get the final document
 * 2. Do a LINE-LEVEL diff between original and modified
 * 3. Group consecutive changed lines into patches
 * 4. Format each patch as `filename:linenum\n-old\n+new`
 */
export function formatAsCustomDiffPatch(
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
	docContent: string,
	filePath: string,
): string {
	// Step 1: Apply all edits to get the modified document
	const modifiedContent = applyEditsToContent(docContent, oracleEdits);

	// Step 2: Line-level diff
	const oldLines = splitLines(docContent);
	const newLines = splitLines(modifiedContent);

	// Step 3: Find changed line groups
	// Walk both arrays, find runs of consecutive lines that differ
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

		// Found a difference — collect the full run of changed lines
		const startLine = i;
		const removedLines: string[] = [];
		const addedLines: string[] = [];

		// Simple approach: collect all consecutive differing lines
		// For lines that exist in old but changed, they're "removed"
		// For lines that exist in new but changed, they're "added"
		while (i < maxLen) {
			const ol = i < oldLines.length ? oldLines[i] : undefined;
			const nl = i < newLines.length ? newLines[i] : undefined;

			if (ol === nl) {
				break; // back to matching lines
			}

			if (ol !== undefined) {
				removedLines.push(ol);
			}
			if (nl !== undefined) {
				addedLines.push(nl);
			}
			i++;
		}

		// Only emit patch if we have both removed and added lines
		// (PatchBased02 handler requires both)
		if (removedLines.length > 0 && addedLines.length > 0) {
			patches.push([
				`${filePath}:${startLine}`,
				...removedLines.map(l => `-${l}`),
				...addedLines.map(l => `+${l}`),
			].join('\n'));
		} else if (removedLines.length > 0) {
			// Pure deletion — include empty replacement
			patches.push([
				`${filePath}:${startLine}`,
				...removedLines.map(l => `-${l}`),
				`+`,
			].join('\n'));
		} else if (addedLines.length > 0) {
			// Pure insertion — include the previous line as anchor if possible
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

// ---------------------------------------------------------------------------
// Edit window parsing from generated prompt
// ---------------------------------------------------------------------------

/**
 * Parse the edit window content from a generated user prompt.
 * Looks for content between `<|code_to_edit|>` and `<|/code_to_edit|>` tags.
 *
 * Returns the edit window lines and the line numbers (if line numbers are
 * embedded in the prompt, they are stripped to get pure content).
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
	// The content starts/ends with newlines from the tag placement
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

// ---------------------------------------------------------------------------
// Xtab275 (EditWindowOnly) formatter
// ---------------------------------------------------------------------------

/**
 * Format oracle edits as Xtab275 edit-window content.
 *
 * The model response for Xtab275 is the ENTIRE edit window content after
 * applying the edit. We:
 * 1. Find the edit window range in the original document
 * 2. Apply oracle edits to the full document
 * 3. Re-extract the edit window lines (adjusting for line count changes)
 */
export function formatAsEditWindowOnly(
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
	docContent: string,
	editWindowStartLine: number,
	editWindowLineCount: number,
): string {
	const editWindowEndLine = editWindowStartLine + editWindowLineCount;

	// Apply edits to get modified document
	const modifiedContent = applyEditsToContent(docContent, oracleEdits);
	const modifiedLines = splitLines(modifiedContent);

	// Calculate net line change from edits within the window
	let netLineChange = 0;
	for (const [start, endEx, text] of oracleEdits) {
		const editStartLine = offsetToLineNumber(docContent, start);
		const editEndLine = offsetToLineNumber(docContent, endEx);

		// Only count edits that overlap with the edit window
		if (editStartLine < editWindowEndLine && editEndLine >= editWindowStartLine) {
			const oldLineCount = splitLines(docContent.substring(start, endEx)).length;
			const newLineCount = text.length > 0 ? splitLines(text).length : 0;
			// Adjust: if old text is empty (pure insertion), old count should be 0
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

	// Strip line numbers from edit window lines if present (format: "N| content")
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

	return 0; // last resort fallback
}

/**
 * Strip line number prefix (e.g., "5| ") from a prompt line.
 */
function stripLineNumber(line: string): string {
	const match = line.match(/^\d+\| /);
	if (match) {
		return line.substring(match[0].length);
	}
	return line;
}

// ---------------------------------------------------------------------------
// Model response passthrough
// ---------------------------------------------------------------------------

/**
 * Get the model response directly from the telemetry row.
 * Works for any strategy — returns the raw model output.
 */
export function getModelResponse(row: ITelemetryRow): string {
	return row.modelResponse;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Generate the assistant response for a training sample.
 */
export function generateResponse(
	strategy: string,
	responseSource: 'oracle' | 'model',
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[] | undefined,
	docContent: string,
	filePath: string,
	userPrompt: string,
	row: ITelemetryRow,
): IGeneratedResponse | { error: string } {
	// Model path: use raw model response from telemetry
	if (responseSource === 'model') {
		return {
			assistant: getModelResponse(row),
			source: 'model',
		};
	}

	// Oracle path: format oracle edit per strategy
	if (!oracleEdits || oracleEdits.length === 0) {
		return { error: 'No oracle edits available for oracle response source' };
	}

	const normalizedStrategy = strategy.toLowerCase();

	// PatchBased strategies → CustomDiffPatch format
	if (normalizedStrategy === 'patchbased02' || normalizedStrategy === 'patchbased01' || normalizedStrategy === 'patchbased') {
		const assistant = formatAsCustomDiffPatch(oracleEdits, docContent, filePath);
		if (!assistant) {
			return { error: 'formatAsCustomDiffPatch produced empty result' };
		}
		return { assistant, source: 'oracle' };
	}

	// Xtab275 strategies → EditWindowOnly format
	if (normalizedStrategy === 'xtab275' || normalizedStrategy === 'xtabaggressiveness' || normalizedStrategy === 'xtab275aggressiveness') {
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

// ---------------------------------------------------------------------------
// Batch processing + diagnostics
// ---------------------------------------------------------------------------

export interface IResponseGenerationInput {
	readonly index: number;
	readonly oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[] | undefined;
	readonly docContent: string;
	readonly filePath: string;
	readonly userPrompt: string;
	readonly row: ITelemetryRow;
}

/**
 * Generate responses for all inputs.
 */
export function generateAllResponses(
	strategy: string,
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

/**
 * Print diagnostic summary of generated responses.
 */
export function printResponseDiagnostics(
	responses: readonly { index: number; response: IGeneratedResponse }[],
	errors: readonly { index: number; error: string }[],
): void {
	console.log('\n=== Response Generation Results ===');
	console.log(`Successfully generated: ${responses.length}`);
	console.log(`Errors: ${errors.length}`);

	if (errors.length > 0) {
		console.log('\n--- Response Errors ---');
		for (const err of errors) {
			console.log(`  Row ${err.index}: ${err.error}`);
		}
	}

	if (responses.length > 0) {
		const sources = { oracle: 0, model: 0 };
		let totalLen = 0;
		for (const { response } of responses) {
			sources[response.source]++;
			totalLen += response.assistant.length;
		}
		console.log(`\n--- Response Stats ---`);
		console.log(`  Source: oracle=${sources.oracle}, model=${sources.model}`);
		console.log(`  Avg response length: ${Math.round(totalLen / responses.length)} chars`);

		// For small sets, dump responses
		const dumpAll = responses.length <= 5;
		for (const { index, response } of responses) {
			console.log(`\n--- Row ${index}: Response (${response.source}) ---`);
			console.log(`  Length: ${response.assistant.length} chars`);
			if (dumpAll) {
				console.log(`\n  === ASSISTANT ===\n${response.assistant}\n`);
			} else if (index === responses[0].index) {
				console.log(`  Preview: ${response.assistant.substring(0, 300)}...`);
			}
		}
	}
}
