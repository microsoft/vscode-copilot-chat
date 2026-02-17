/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sweep Module - Integration with SweepAI's next-edit-1.5B model
 *
 * This module implements support for the SweepAI next-edit prediction model, a 1.5B parameter
 * model specifically trained for predicting the next code edit based on recent changes.
 *
 * ## Background
 *
 * SweepAI's VS Code extension uses server-side prompt modification before sending to the model.
 * Since we run the model locally (via Ollama), we reverse-engineered the prompt format from:
 * - The HuggingFace reference implementation
 * - The VS Code extension source code
 * - The blog post explaining the approach
 *
 * ## Resources
 *
 * - **Blog Post**: https://blog.sweep.dev/posts/oss-next-edit
 *   Explains the model architecture, training data, and the 21-line window format.
 *
 * - **Model on HuggingFace**: https://huggingface.co/sweepai/sweep-next-edit-1.5B
 *   The model weights and tokenizer.
 *
 * - **Reference Implementation**: https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py
 *   Python script showing the exact prompt format and inference pipeline. This was our primary
 *   reference for reverse-engineering the prompt structure.
 *
 * - **VS Code Extension**: https://github.com/sweepai/vscode-nes
 *   SweepAI's official VS Code extension. Note: The extension sends prompts to SweepAI's server
 *   which modifies them before inference. Our implementation constructs the final prompt locally.
 *
 * ## Prompt Format
 *
 * The model expects a specific prompt structure using `<|file_sep|>` tokens:
 *
 * ```
 * <|file_sep|>{context_file_path}
 * {context_file_content}
 *
 * <|file_sep|>{active_file}.diff
 * original:
 * {changed_lines_before}
 * updated:
 * {changed_lines_after}
 *
 * <|file_sep|>original/{active_file}
 * {21_lines_around_cursor_BEFORE_session_edits}
 *
 * <|file_sep|>current/{active_file}
 * {21_lines_around_cursor_NOW}
 *
 * <|file_sep|>updated/{active_file}
 * ```
 *
 * The model then generates the predicted 21-line window for `updated/`.
 *
 * ## Key Concepts
 *
 * 1. **21-Line Window**: The model works with a fixed window of 21 lines (10 above cursor,
 *    cursor line, 10 below). This is different from full-file approaches and matches the
 *    format described in https://blog.sweep.dev/posts/oss-next-edit
 *
 * 2. **Original vs Current**: "Original" is the file state BEFORE the editing session started.
 *    "Current" is the file state NOW. The model uses this to understand the edit trajectory.
 *
 * 3. **Diff History**: Recent edits are included as diff blocks showing what changed,
 *    helping the model understand the user's editing pattern.
 *
 * 4. **Window Alignment**: When the user adds/removes lines, we must map the cursor position
 *    from "current" coordinates back to "original" coordinates. This is a custom algorithm
 *    we developed since SweepAI's server handles this transparently.
 *
 * ## Implementation Notes
 *
 * - Token budget: 7000 tokens total (model context is limited)
 * - Response: Model outputs the updated 21-line window
 * - We diff the response against the current window to extract actual edits
 * - Coordinate conversion: Window-relative line numbers must be converted to document coordinates
 *
 * @see https://blog.sweep.dev/posts/oss-next-edit for detailed explanation
 * @see https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py for reference impl
 */

import { ChatFetchError } from '../../../../platform/chat/common/commonTypes';
import { IDiffService } from '../../../../platform/diff/common/diffService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { PromptOptions } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { NoNextEditReason, StatelessNextEditDocument, StreamedEdit } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { IXtabHistoryEditEntry, IXtabHistoryEntry } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { pushMany } from '../../../../util/vs/base/common/arrays';
import { LineReplacement } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { LineRange } from '../../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { PromptPieces } from '../promptCrafting';
import { toUniquePath } from '../promptCraftingUtils';

// ============================================================================
// CONSTANTS
// ============================================================================
// These values match the SweepAI model's expected input format.
// See: https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py

/**
 * Lines to include above cursor in the 21-line window.
 *
 * The SweepAI model expects exactly 10 lines above + cursor line + 10 lines below = 21 lines.
 * This fixed window size is a core part of the model's training and inference format.
 *
 * @see https://blog.sweep.dev/posts/oss-next-edit - "Window Format" section
 */
export const SWEEP_WINDOW_LINES_ABOVE = 10;

/**
 * Lines to include below cursor in the 21-line window.
 * @see https://blog.sweep.dev/posts/oss-next-edit - "Window Format" section
 */
export const SWEEP_WINDOW_LINES_BELOW = 10;

/** Maximum number of individual diff blocks to include in the prompt */
const MAX_DIFF_BLOCKS = 15;

/**
 * Total token budget for the prompt.
 * The SweepAI model has a context limit, and since it only outputs ~21 lines,
 * we allocate most of the budget to input context.
 */
const TOTAL_PROMPT_BUDGET = 7000;

/** Token budget allocated for diff history (recent changes) */
const DIFF_BUDGET = 3500;

/** Token budget allocated for context files (recently viewed files) */
const CONTEXT_FILES_BUDGET = 3500;

/**
 * SweepAI's special file separator token.
 * This delimiter is used to separate different sections of the prompt.
 * The model was trained to recognize this token structure.
 *
 * @see https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py
 */
const FILE_SEP = '<|file_sep|>';

// ============================================================================
// PROMPT HELPERS
// ============================================================================

/**
 * Extract 21-line window around cursor position.
 *
 * This implements the window extraction as described in SweepAI's blog post.
 * The model expects exactly 21 lines: 10 above cursor, cursor line, 10 below.
 *
 * @param content - The file content to extract from
 * @param cursorLine - The 0-based line number where the cursor is
 * @returns The extracted 21-line window (may be shorter at file boundaries)
 *
 * @see https://blog.sweep.dev/posts/oss-next-edit - explains the 21-line window format
 */
function extract21LineWindow(content: string, cursorLine: number): string {
	const lines = content.split('\n');

	// Calculate window bounds (0-based indexing)
	const startLine = Math.max(0, cursorLine - SWEEP_WINDOW_LINES_ABOVE);
	const endLine = Math.min(lines.length, cursorLine + SWEEP_WINDOW_LINES_BELOW + 1);

	// Extract the window
	return lines.slice(startLine, endLine).join('\n');
}

/**
 * Map cursor position from current file to original file using line delta.
 *
 * ## Why This Is Needed
 *
 * SweepAI's VS Code extension sends the prompt to their server, which handles window
 * alignment transparently. Since we run locally, we must do this ourselves.
 *
 * When the user adds or removes lines during editing:
 * - The cursor is at line N in the "current" file
 * - But line N in the "original" file may be completely different content
 * - We need to find the corresponding line in "original" to show matching context
 *
 * ## Algorithm (Line Delta Approach)
 *
 * 1. Find first line where original and current differ (scan from start)
 * 2. Find last line where they differ (scan from end)
 * 3. Map cursor position based on where it falls:
 *    - Before changes: same line number (unchanged region)
 *    - Within changed region: proportional mapping (ratio of lengths)
 *    - After changes: subtract the line count delta
 *
 * ## Example
 *
 * ```
 * Original (10 lines):     Current (12 lines):
 * 0: import              0: import
 * 1: function            1: function
 * 2: // old              2: // new line 1  ← INSERTED
 * 3: return              3: // new line 2  ← INSERTED
 * 4: }                   4: // old
 *                        5: return
 *                        6: }
 *
 * Cursor at line 6 in current → maps to line 4 in original
 * (cursor is after the inserted lines, so subtract delta of 2)
 * ```
 *
 * @param originalContent - File content BEFORE the editing session
 * @param currentContent - File content NOW
 * @param cursorLine - Cursor position in current file (0-based)
 * @returns The 21-line window from original, centered on the mapped cursor position
 *
 * @see extractOriginalWindow is our custom implementation since SweepAI's server
 *      handles this transparently for their extension
 */
function extractOriginalWindow(
	originalContent: string,
	currentContent: string,
	cursorLine: number
): string {
	// If files are identical, just extract the same window
	if (originalContent === currentContent) {
		return extract21LineWindow(originalContent, cursorLine);
	}

	// If original is empty, return empty
	if (originalContent.length === 0) {
		return '';
	}

	const originalLines = originalContent.split('\n');
	const currentLines = currentContent.split('\n');

	// Find first divergence point
	let firstDiff = 0;
	const minLen = Math.min(originalLines.length, currentLines.length);
	for (let i = 0; i < minLen; i++) {
		if (originalLines[i] !== currentLines[i]) {
			firstDiff = i;
			break;
		}
		if (i === minLen - 1) {
			firstDiff = minLen; // No difference found in common prefix
		}
	}

	// Find last divergence point (from end)
	let origEnd = originalLines.length - 1;
	let currEnd = currentLines.length - 1;
	while (origEnd > firstDiff && currEnd > firstDiff && originalLines[origEnd] === currentLines[currEnd]) {
		origEnd--;
		currEnd--;
	}

	// Map cursor from current-space to original-space
	let originalCursorLine: number;

	if (cursorLine < firstDiff) {
		// Cursor before changes - same line
		originalCursorLine = cursorLine;
	} else if (cursorLine <= currEnd) {
		// Cursor within changed region - map proportionally
		const origDiffLen = origEnd - firstDiff + 1;
		const currDiffLen = currEnd - firstDiff + 1;
		const offsetInChange = cursorLine - firstDiff;

		if (currDiffLen > 0 && origDiffLen > 0) {
			const ratio = origDiffLen / currDiffLen;
			const mappedOffset = Math.round(offsetInChange * ratio);
			originalCursorLine = firstDiff + Math.min(mappedOffset, origDiffLen - 1);
		} else if (origDiffLen === 0) {
			// Pure insertion - map to insertion point
			originalCursorLine = firstDiff;
		} else {
			// Pure deletion - map to start of deleted region
			originalCursorLine = firstDiff;
		}
	} else {
		// Cursor after changes - apply delta
		const delta = currEnd - origEnd;
		originalCursorLine = cursorLine - delta;
	}

	// Clamp to valid range
	originalCursorLine = Math.max(0, Math.min(originalCursorLine, originalLines.length - 1));

	return extract21LineWindow(originalContent, originalCursorLine);
}

/**
 * Get recently viewed files formatted for Sweep prompt.
 *
 * Includes other files the user has recently viewed/edited as additional context.
 * This helps the model understand the broader codebase context.
 *
 * @see https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py - context files
 */
function getRecentFilesForSweep(
	activeDoc: StatelessNextEditDocument,
	xtabHistory: readonly IXtabHistoryEntry[],
	computeTokens: (s: string) => number,
	opts: PromptOptions,
): { path: string; content: string }[] {
	const result: { path: string; content: string }[] = [];
	const seenDocs = new Set<DocumentId>();
	let tokenBudget = opts.recentlyViewedDocuments.maxTokens;

	// Traverse from most recent to least recent
	for (let i = xtabHistory.length - 1; i >= 0 && result.length < opts.recentlyViewedDocuments.nDocuments; --i) {
		const entry = xtabHistory[i];

		// Skip active document and already seen documents
		if (entry.docId === activeDoc.id || seenDocs.has(entry.docId)) {
			continue;
		}

		// Skip view entries if not configured to include them
		if (!opts.recentlyViewedDocuments.includeViewedFiles && entry.kind === 'visibleRanges') {
			continue;
		}

		seenDocs.add(entry.docId);

		const content = entry.kind === 'edit'
			? entry.edit.edit.applyOnText(entry.edit.base)
			: entry.documentContent;

		const contentStr = content.value;
		const tokens = computeTokens(contentStr);

		if (tokenBudget - tokens < 0) {
			break;
		}

		tokenBudget -= tokens;
		const path = toUniquePath(entry.docId, activeDoc.workspaceRoot?.path);
		result.push({ path, content: contentStr });
	}

	return result; // Keep newest first - prioritize most recent files if budget runs out
}

// ============================================================================
// PROMPT CONSTRUCTION
// ============================================================================

/**
 * Constructs a prompt for the Sweep next-edit-1.5B model.
 *
 * ## Prompt Format
 *
 * SweepAI's model expects a specific prompt structure:
 *
 * ```
 * <|file_sep|>{context_file_path}
 * {context_file_content}
 * <|file_sep|>{active_file}.diff
 * original:
 * {only_changed_lines_before}
 * updated:
 * {only_changed_lines_after}
 * <|file_sep|>original/{active_file_path}
 * {21_lines_BEFORE_editing_session}
 * <|file_sep|>current/{active_file_path}
 * {21_lines_NOW}
 * <|file_sep|>updated/{active_file_path}
 * ```
 *
 * The model generates content after `updated/` to predict the next edit.
 *
 * ## Token Budget
 *
 * - Total: ~7000 tokens (model only outputs ~21 lines)
 * - Diffs: 3500 tokens, max 15 blocks
 * - Context files: 3500 tokens
 * - Original/Current: Fixed 21-line window (no budget limit, ~42 lines total)
 *
 * ## Key Differences from SweepAI's Extension
 *
 * SweepAI's VS Code extension sends prompts to their server which modifies them
 * before inference. Since we run locally via Ollama, we reverse-engineered the
 * format from their public resources.
 *
 * @param promptPieces - The prompt context including document state and history
 * @returns The formatted prompt string ready for the model
 *
 * @see https://blog.sweep.dev/posts/oss-next-edit - explains the prompt format
 * @see https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py - reference implementation
 * @see https://github.com/sweepai/vscode-nes - SweepAI's VS Code extension (prompt goes to server)
 */
export function constructSweepPrompt(promptPieces: PromptPieces): string {
	const parts: string[] = [];

	const { activeDoc, xtabHistory, computeTokens, currentDocument } = promptPieces;

	// Get file path and name
	const filePath = toUniquePath(activeDoc.id, activeDoc.workspaceRoot?.path);
	const fileName = filePath.includes('/') ? filePath.split('/').pop()! : filePath;

	// Step 1: Collect edit entries from xtabHistory for current file only
	const editEntries: IXtabHistoryEditEntry[] = [];
	for (const entry of xtabHistory) {
		if (entry.kind === 'edit' && entry.docId === activeDoc.id) {
			editEntries.push(entry);
		}
	}

	// Step 2: Compute "original" = entry0.base (oldest entry's base)
	// Compute "current" = activeDoc.documentAfterEdits (current state)
	const originalContent = editEntries.length > 0
		? editEntries[0].edit.base.value
		: activeDoc.documentBeforeEdits.value;
	const currentContent = activeDoc.documentAfterEdits.value;

	// Step 3: Build individual diffs - extract ONLY changed lines using toLineEdit
	// Budget: DIFF_BUDGET tokens, max MAX_DIFF_BLOCKS blocks
	let diffTokenBudget = DIFF_BUDGET;
	let diffBlockCount = 0;
	const diffParts: string[] = [];
	let budgetExceeded = false;

	// Process entries from oldest to newest
	for (const entry of editEntries) {
		if (budgetExceeded || diffBlockCount >= MAX_DIFF_BLOCKS) {
			break;
		}

		const lineEdit = RootedEdit.toLineEdit(entry.edit);

		for (const singleLineEdit of lineEdit.replacements) {
			if (diffBlockCount >= MAX_DIFF_BLOCKS) {
				budgetExceeded = true;
				break;
			}

			// Get only the changed lines, not full file
			const oldLines = entry.edit.base.getLines().slice(
				singleLineEdit.lineRange.startLineNumber - 1,
				singleLineEdit.lineRange.endLineNumberExclusive - 1
			);
			const newLines = singleLineEdit.newLines;

			// Skip empty diffs (no actual changes)
			const oldContent = oldLines.join('\n').trim();
			const newContent = newLines.join('\n').trim();
			if (!oldContent && !newContent) {
				continue;
			}

			// Calculate tokens for this diff block
			const diffBlock = `${FILE_SEP}${fileName}.diff\noriginal:\n${oldContent}\nupdated:\n${newContent}`;
			const diffTokens = computeTokens(diffBlock);

			if (diffTokenBudget - diffTokens < 0) {
				budgetExceeded = true;
				break;
			}

			diffTokenBudget -= diffTokens;
			diffBlockCount++;

			diffParts.push(`${FILE_SEP}${fileName}.diff`);
			diffParts.push('original:');
			if (oldContent) {
				diffParts.push(oldContent);
			}
			diffParts.push('updated:');
			if (newContent) {
				diffParts.push(newContent);
			}
		}
	}

	// Step 4: Build original/current sections with 21-line window around cursor
	// Use rebase approach: compose all user edits and map window bounds back to original
	const cursorLine = currentDocument.cursorLineOffset;

	// If original is empty (file created during session), skip Sweep entirely
	// The model doesn't work well without an original baseline to compare against
	if (originalContent.trim().length === 0) {
		return '';
	}

	// Extract current window (this is straightforward)
	const currentSection = extract21LineWindow(currentContent, cursorLine);

	// For original window, map cursor position from current-space to original-space
	const originalSection = extractOriginalWindow(
		originalContent,
		currentContent,
		cursorLine
	);

	// Step 5: Calculate remaining budget for context files
	const diffTokensUsed = DIFF_BUDGET - diffTokenBudget;
	const originalCurrentTokens = computeTokens(originalSection) + computeTokens(currentSection);
	const usedTokens = diffTokensUsed + originalCurrentTokens;
	const remainingBudget = Math.max(0, TOTAL_PROMPT_BUDGET - usedTokens - 100); // 100 tokens overhead for tags

	// Step 6: Insert context files (newest first, only if budget allows)
	const contextParts: string[] = [];
	let contextTokenBudget = Math.min(remainingBudget, CONTEXT_FILES_BUDGET);

	const recentFiles = getRecentFilesForSweep(activeDoc, xtabHistory, computeTokens, promptPieces.opts);
	for (const file of recentFiles) {
		const fileBlock = `${FILE_SEP}${file.path}\n${file.content}`;
		const fileTokens = computeTokens(fileBlock);

		if (contextTokenBudget - fileTokens < 0) {
			break;
		}
		contextTokenBudget -= fileTokens;

		contextParts.push(`${FILE_SEP}${file.path}`);
		contextParts.push(file.content);
	}

	// Assemble final prompt: context files -> diffs -> original/current/updated
	pushMany(parts, contextParts);
	pushMany(parts, diffParts);

	parts.push(`${FILE_SEP}original/${fileName}`);
	parts.push(originalSection);

	parts.push(`${FILE_SEP}current/${fileName}`);
	parts.push(currentSection);

	// Updated = prompt for model to complete
	parts.push(`${FILE_SEP}updated/${fileName}`);

	return parts.join('\n');
}

// ============================================================================
// RESPONSE HANDLING
// ============================================================================

/**
 * Parameters for handling Sweep model response.
 */
export interface SweepResponseParams {
	/** Stream of response lines from the model */
	linesStream: AsyncIterable<string>;
	/** Prompt pieces containing document context */
	promptPieces: PromptPieces;
	/** Diff service for computing changes */
	diffService: IDiffService;
	/** Document state before edits */
	documentBeforeEdits: StringText;
	/** Edit window range */
	editWindow: OffsetRange;
	/** Whether this is from a cursor jump retry */
	isFromCursorJump: boolean;
	/** Tracer for logging */
	tracer: { trace: (msg: string) => void };
	/** Chat response failure if any */
	chatResponseFailure: ChatFetchError | undefined;
	/** Error mapper function */
	mapChatFetcherError: (error: ChatFetchError) => NoNextEditReason;
}

/**
 * Handles Sweep model response by diffing against the 21-line window.
 *
 * ## How Response Processing Works
 *
 * The model outputs an updated 21-line window after `<|file_sep|>updated/{file}`.
 * We need to extract the actual changes and apply them to the correct document lines.
 *
 * ### Algorithm
 *
 * 1. **Collect** all response lines (model outputs ~21 lines)
 * 2. **Recompute** the same 21-line window we sent (for comparison)
 * 3. **Diff** the response against the window to find exact changes
 * 4. **Convert** window-relative line numbers to document line numbers
 * 5. **Yield** the edits with correct document coordinates
 *
 * ### Coordinate Conversion Example
 *
 * ```
 * Document (100 lines), cursor at line 50:
 *   sweepWindowStart = 50 - 10 = 40
 *   sweepWindowEnd = 50 + 10 + 1 = 61
 *
 * Model changes window line 5 (0-indexed):
 *   Document line = 40 + 5 = 45
 * ```
 *
 * ### Why This Is Needed
 *
 * SweepAI's VS Code extension handles response parsing on their server.
 * Since we run locally, we must do this ourselves. The model doesn't output
 * document line numbers - it outputs a complete 21-line window that we must
 * diff to find the changes.
 *
 * @param params - Response handling parameters
 * @returns Async generator yielding edits, ending with a NoNextEditReason
 *
 * @see constructSweepPrompt - builds the prompt that produces this response
 * @see https://blog.sweep.dev/posts/oss-next-edit - explains the window format
 */
export async function* handleSweepResponse(
	params: SweepResponseParams
): AsyncGenerator<StreamedEdit, NoNextEditReason> {
	const {
		linesStream,
		promptPieces,
		diffService,
		documentBeforeEdits,
		editWindow,
		isFromCursorJump,
		tracer,
		chatResponseFailure,
		mapChatFetcherError
	} = params;

	// Step 1: Collect response lines
	const responseLines: string[] = [];
	for await (const line of linesStream) {
		responseLines.push(line);
	}

	// Check for errors after collecting
	if (chatResponseFailure) {
		return mapChatFetcherError(chatResponseFailure);
	}

	// Step 2: Strip leading/trailing empty lines
	while (responseLines.length > 0 && responseLines[0].trim() === '') {
		responseLines.shift();
	}
	while (responseLines.length > 0 && responseLines[responseLines.length - 1].trim() === '') {
		responseLines.pop();
	}

	if (responseLines.length === 0) {
		return new NoNextEditReason.NoSuggestions(documentBeforeEdits, editWindow);
	}

	// Step 3: Compute the SAME 21-line window that was sent to the model
	const cursorLine = promptPieces.currentDocument.cursorLineOffset;
	const sweepWindowStart = Math.max(0, cursorLine - SWEEP_WINDOW_LINES_ABOVE);
	const sweepWindowEnd = Math.min(
		promptPieces.currentDocument.lines.length,
		cursorLine + SWEEP_WINDOW_LINES_BELOW + 1
	);

	// Get the 21-line window from current document (same window we sent to model)
	const windowLines = promptPieces.currentDocument.lines.slice(sweepWindowStart, sweepWindowEnd);

	tracer.trace(`Sweep window: lines ${sweepWindowStart}-${sweepWindowEnd} (cursor at ${cursorLine}), window has ${windowLines.length} lines, response has ${responseLines.length} lines`);

	// Step 4: Compute diff between the window and model response
	const diffResult = await diffService.computeDiff(
		windowLines.join('\n'),
		responseLines.join('\n'),
		{ ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false }
	);

	tracer.trace(`Sweep smart extraction: found ${diffResult.changes.length} changes`);

	// Step 5: Yield only the actual changes, adjusting line numbers to full document coordinates
	for (const change of diffResult.changes) {
		// Adjust line numbers: diff is relative to window, convert to full document
		const docStartLine = sweepWindowStart + change.original.startLineNumber;
		const docEndLine = sweepWindowStart + change.original.endLineNumberExclusive;
		const singleLineEdit = new LineReplacement(
			new LineRange(docStartLine, docEndLine),
			responseLines.slice(change.modified.startLineNumber - 1, change.modified.endLineNumberExclusive - 1)
		);
		tracer.trace(`Sweep edit: ${singleLineEdit.toString()}`);
		yield { edit: singleLineEdit, isFromCursorJump, window: editWindow };
	}

	return new NoNextEditReason.NoSuggestions(documentBeforeEdits, editWindow);
}
