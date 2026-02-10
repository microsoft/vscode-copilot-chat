/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../platform/inlineEdits/common/dataTypes/edit';
import { LanguageContextResponse } from '../../../platform/inlineEdits/common/dataTypes/languageContext';
import * as xtabPromptOptions from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { AggressivenessLevel, CurrentFileOptions, DiffHistoryOptions, PromptingStrategy, PromptOptions } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditDocument } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { IXtabHistoryEditEntry, IXtabHistoryEntry } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ContextKind, TraitContext } from '../../../platform/languageServer/common/languageContextService';
import { Result } from '../../../util/common/result';
import { pushMany, range } from '../../../util/vs/base/common/arrays';
import { assertNever } from '../../../util/vs/base/common/assert';
import { illegalArgument } from '../../../util/vs/base/common/errors';
import { Schemas } from '../../../util/vs/base/common/network';
import { StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { LintErrors } from './lintErrors';
import { PromptTags } from './tags';
import { CurrentDocument } from './xtabCurrentDocument';

export class PromptPieces {
	constructor(
		public readonly currentDocument: CurrentDocument,
		public readonly editWindowLinesRange: OffsetRange,
		public readonly areaAroundEditWindowLinesRange: OffsetRange,
		public readonly activeDoc: StatelessNextEditDocument,
		public readonly xtabHistory: readonly IXtabHistoryEntry[],
		public readonly taggedCurrentDocLines: readonly string[],
		public readonly areaAroundCodeToEdit: string,
		public readonly langCtx: LanguageContextResponse | undefined,
		public readonly aggressivenessLevel: AggressivenessLevel,
		public readonly lintErrors: LintErrors | undefined,
		public readonly computeTokens: (s: string) => number,
		public readonly opts: PromptOptions,
	) {
	}
}

const MAX_DIFF_BLOCKS = 15; // Maximum number of individual diff blocks to include
const TOTAL_PROMPT_BUDGET = 7000; // Total token budget for prompt (model only outputs ~21 lines)
const FILE_SEP = '<|file_sep|>';

// 21-line window: 10 lines above cursor, cursor line, 10 lines below cursor
// This matches SweepAI's blog post format for local model inference
const CURSOR_WINDOW_LINES_ABOVE = 10;
const CURSOR_WINDOW_LINES_BELOW = 10;

// Budget allocation for 7000 tokens:
// - Diffs: ~3500 tokens (prioritized)
// - Context files: ~3500 tokens (fills remaining)
// Note: Original/Current sections are fixed at 21 lines each (~100-200 tokens)
const DIFF_BUDGET = 3500;
const CONTEXT_FILES_BUDGET = 3500;

/**
 * Constructs a prompt for the Sweep next-edit-1.5B model.
 *
 * Token budget: 7000 tokens total (model only outputs ~21 lines)
 * Priority: Diffs (3500) > Context files (3500)
 * Original/Current: Fixed 21-line window around cursor
 *
 * Format:
 *   <|file_sep|>{file_path_1}
 *   {file_content_1}
 *   <|file_sep|>{changed_file}.diff
 *   original:
 *   {only_changed_lines_before}
 *   updated:
 *   {only_changed_lines_after}
 *   <|file_sep|>original/{file_path}
 *   {21_lines_around_cursor_before_session_edits}
 *   <|file_sep|>current/{file_path}
 *   {21_lines_around_cursor_now}
 *   <|file_sep|>updated/{file_path}
 */
export function nextEditConstructPrompt(promptPieces: PromptPieces): string {
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
	// 10 lines above cursor, cursor line, 10 lines below = 21 lines total
	const cursorLine = currentDocument.cursorLineOffset;

	const originalSection = extract21LineWindow(originalContent, cursorLine);
	const currentSection = extract21LineWindow(currentContent, cursorLine);

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

/**
 * Extract 21-line window around cursor position.
 * 10 lines above cursor, cursor line, 10 lines below cursor.
 * This matches SweepAI's blog post format for local model inference.
 */
function extract21LineWindow(content: string, cursorLine: number): string {
	const lines = content.split('\n');

	// Calculate window bounds (0-based indexing)
	const startLine = Math.max(0, cursorLine - CURSOR_WINDOW_LINES_ABOVE);
	const endLine = Math.min(lines.length, cursorLine + CURSOR_WINDOW_LINES_BELOW + 1);

	// Extract the window
	return lines.slice(startLine, endLine).join('\n');
}

/**
 * Get recently viewed files formatted for Sweep prompt.
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

export function getUserPrompt(promptPieces: PromptPieces): string {

	const { activeDoc, xtabHistory, taggedCurrentDocLines, areaAroundCodeToEdit, langCtx, aggressivenessLevel, lintErrors, computeTokens, opts } = promptPieces;
	const currentFileContent = taggedCurrentDocLines.join('\n');

	const { codeSnippets: recentlyViewedCodeSnippets, documents: docsInPrompt } = getRecentCodeSnippets(activeDoc, xtabHistory, langCtx, computeTokens, opts);

	docsInPrompt.add(activeDoc.id); // Add active document to the set of documents in prompt

	const editDiffHistory = getEditDiffHistory(activeDoc, xtabHistory, docsInPrompt, computeTokens, opts.diffHistory);

	const relatedInformation = getRelatedInformation(langCtx);

	const currentFilePath = toUniquePath(activeDoc.id, activeDoc.workspaceRoot?.path);

	const postScript = promptPieces.opts.includePostScript ? getPostScript(opts.promptingStrategy, currentFilePath, aggressivenessLevel) : '';

	const lintsWithNewLinePadding = lintErrors ? `\n${lintErrors.getFormattedLintErrors()}\n` : '';

	const basePrompt = `${PromptTags.RECENT_FILES.start}
${recentlyViewedCodeSnippets}
${PromptTags.RECENT_FILES.end}

${PromptTags.CURRENT_FILE.start}
current_file_path: ${currentFilePath}
${currentFileContent}
${PromptTags.CURRENT_FILE.end}
${lintsWithNewLinePadding}
${PromptTags.EDIT_HISTORY.start}
${editDiffHistory}
${PromptTags.EDIT_HISTORY.end}`;

	const mainPrompt =
		opts.promptingStrategy !== PromptingStrategy.PatchBased01
			? basePrompt + `\n\n${areaAroundCodeToEdit}`
			: basePrompt;

	const includeBackticks = opts.promptingStrategy !== PromptingStrategy.Nes41Miniv3 &&
		opts.promptingStrategy !== PromptingStrategy.Codexv21NesUnified &&
		opts.promptingStrategy !== PromptingStrategy.PatchBased01;

	const packagedPrompt = includeBackticks ? wrapInBackticks(mainPrompt) : mainPrompt;
	const packagedPromptWithRelatedInfo = addRelatedInformation(relatedInformation, packagedPrompt, opts.languageContext.traitPosition);
	const prompt = packagedPromptWithRelatedInfo + postScript;

	const trimmedPrompt = prompt.trim();

	return trimmedPrompt;
}

function wrapInBackticks(content: string) {
	return `\`\`\`\n${content}\n\`\`\``;
}

function addRelatedInformation(relatedInformation: string, prompt: string, position: 'before' | 'after'): string {
	if (position === 'before') {
		return appendWithNewLineIfNeeded(relatedInformation, prompt, 2);
	}
	return appendWithNewLineIfNeeded(prompt, relatedInformation, 2);
}

function appendWithNewLineIfNeeded(base: string, toAppend: string, minNewLines: number): string {
	// Count existing newlines at the end of base and start of toAppend
	let existingNewLines = 0;
	for (let i = base.length - 1; i >= 0 && base[i] === '\n'; i--) {
		existingNewLines++;
	}
	for (let i = 0; i < toAppend.length && toAppend[i] === '\n'; i++) {
		existingNewLines++;
	}

	// Add newlines to reach the minimum required
	const newLinesToAdd = Math.max(0, minNewLines - existingNewLines);
	return (base + '\n'.repeat(newLinesToAdd) + toAppend).trim();
}

function getPostScript(strategy: PromptingStrategy | undefined, currentFilePath: string, aggressivenessLevel: AggressivenessLevel) {
	let postScript: string | undefined;
	switch (strategy) {
		case PromptingStrategy.PatchBased01:
		case PromptingStrategy.Codexv21NesUnified:
		case PromptingStrategy.nextEdit:
			break;
		case PromptingStrategy.UnifiedModel:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Start your response with <EDIT>, <INSERT>, or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If you are inserting new code, start with <INSERT> and then provide only the new code that will be inserted at the cursor position followed by </INSERT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Nes41Miniv3:
			postScript = `The developer was working on a section of code within the tags <|code_to_edit|> in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`<|cursor|>\`, please continue the developer's work. Update the <|code_to_edit|> section by predicting and completing the changes they would have made next. Start your response with <EDIT> or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Xtab275EditIntentShort:
		case PromptingStrategy.Xtab275EditIntent:
		case PromptingStrategy.Xtab275:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags, but do not include the tags themselves. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors. Don't include the line numbers or the form #| in your response. Do not skip any lines. Do not be lazy.`;
			break;
		case PromptingStrategy.XtabAggressiveness:
			postScript = `<|aggressive|>${aggressivenessLevel}<|/aggressive|>`;
			break;
		case PromptingStrategy.PatchBased:
			postScript = `Output a modified diff style format with the changes you want. Each change patch must start with \`<filename>:<line number>\` and then include some non empty "anchor lines" preceded by \`-\` and the new lines meant to replace them preceded by \`+\`. Put your changes in the order that makes the most sense, for example edits inside the code_to_edit region and near the user's <|cursor|> should always be prioritized. Output "<NO_EDIT>" if you don't have a good edit candidate.`;
			break;
		case PromptingStrategy.SimplifiedSystemPrompt:
		case PromptingStrategy.CopilotNesXtab:
		case undefined:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. \
Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor \
position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes \
they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags with the following format, but do not include the tags themselves.
\`\`\`
// Your revised code goes here
\`\`\``;
			break;
		default:
			assertNever(strategy);
	}

	const formattedPostScript = postScript === undefined ? '' : `\n\n${postScript}`;
	return formattedPostScript;
}

function getRelatedInformation(langCtx: LanguageContextResponse | undefined): string {
	if (langCtx === undefined) {
		return '';
	}

	const traits = langCtx.items
		.filter(ctx => ctx.context.kind === ContextKind.Trait)
		.map(t => t.context) as TraitContext[];

	if (traits.length === 0) {
		return '';
	}

	const relatedInformation: string[] = [];
	for (const trait of traits) {
		relatedInformation.push(`${trait.name}: ${trait.value}`);
	}

	return `Consider this related information:\n${relatedInformation.join('\n')}`;
}

function getEditDiffHistory(
	activeDoc: StatelessNextEditDocument,
	xtabHistory: readonly IXtabHistoryEntry[],
	docsInPrompt: Set<DocumentId>,
	computeTokens: (s: string) => number,
	{ onlyForDocsInPrompt, maxTokens, nEntries, useRelativePaths }: DiffHistoryOptions
) {
	const workspacePath = useRelativePaths ? activeDoc.workspaceRoot?.path : undefined;

	const reversedHistory = xtabHistory.slice().reverse();

	let tokenBudget = maxTokens;

	const allDiffs: string[] = [];

	// we traverse in reverse (ie from most recent to least recent) because we may terminate early due to token-budget overflow
	for (const entry of reversedHistory) {
		if (allDiffs.length >= nEntries) { // we've reached the maximum number of entries
			break;
		}

		if (entry.kind === 'visibleRanges') {
			continue;
		}

		if (onlyForDocsInPrompt && !docsInPrompt.has(entry.docId)) {
			continue;
		}

		const docDiff = generateDocDiff(entry, workspacePath);
		if (docDiff === null) {
			continue;
		}

		const tokenCount = computeTokens(docDiff);

		tokenBudget -= tokenCount;

		if (tokenBudget < 0) {
			break;
		} else {
			allDiffs.push(docDiff);
		}
	}

	const diffsFromOldestToNewest = allDiffs.reverse();

	let promptPiece = diffsFromOldestToNewest.join('\n\n');

	// to preserve old behavior where we always had trailing whitespace
	if (diffsFromOldestToNewest.length > 0) {
		promptPiece += '\n';
	}

	return promptPiece;
}

function generateDocDiff(entry: IXtabHistoryEditEntry, workspacePath: string | undefined): string | null {
	const docDiffLines: string[] = [];

	const lineEdit = RootedEdit.toLineEdit(entry.edit);

	for (const singleLineEdit of lineEdit.replacements) {
		const oldLines = entry.edit.base.getLines().slice(singleLineEdit.lineRange.startLineNumber - 1, singleLineEdit.lineRange.endLineNumberExclusive - 1);
		const newLines = singleLineEdit.newLines;

		if (oldLines.filter(x => x.trim().length > 0).length === 0 && newLines.filter(x => x.trim().length > 0).length === 0) {
			// skip over a diff which would only contain -/+ without any content
			continue;
		}

		const startLineNumber = singleLineEdit.lineRange.startLineNumber - 1;

		docDiffLines.push(`@@ -${startLineNumber},${oldLines.length} +${startLineNumber},${newLines.length} @@`);
		pushMany(docDiffLines, oldLines.map(x => `-${x}`));
		pushMany(docDiffLines, newLines.map(x => `+${x}`));
	}

	if (docDiffLines.length === 0) {
		return null;
	}

	const uniquePath = toUniquePath(entry.docId, workspacePath);

	const docDiffArr = [
		`--- ${uniquePath}`,
		`+++ ${uniquePath}`,
	];

	pushMany(docDiffArr, docDiffLines);

	const docDiff = docDiffArr.join('\n');

	return docDiff;
}

export function toUniquePath(documentId: DocumentId, workspaceRootPath: string | undefined): string {
	const filePath = documentId.path;
	// remove prefix from path if defined

	const workspaceRootPathWithSlash = workspaceRootPath === undefined ? undefined : (workspaceRootPath.endsWith('/') ? workspaceRootPath : workspaceRootPath + '/');

	const updatedFilePath =
		workspaceRootPathWithSlash !== undefined && filePath.startsWith(workspaceRootPathWithSlash)
			? filePath.substring(workspaceRootPathWithSlash.length)
			: filePath;

	return documentId.toUri().scheme === Schemas.vscodeNotebookCell ? `${updatedFilePath}#${documentId.fragment}` : updatedFilePath;
}

function formatCodeSnippet(
	documentId: DocumentId,
	lines: string[],
	opts: { truncated: boolean; includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption; startLineOffset: number },
): string {
	const filePath = toUniquePath(documentId, undefined);
	const firstLine = opts.truncated
		? `code_snippet_file_path: ${filePath} (truncated)`
		: `code_snippet_file_path: ${filePath}`;

	let formattedLines: string[];
	switch (opts.includeLineNumbers) {
		case xtabPromptOptions.IncludeLineNumbersOption.WithSpaceAfter:
			formattedLines = lines.map((line, idx) => `${opts.startLineOffset + idx}| ${line}`);
			break;
		case xtabPromptOptions.IncludeLineNumbersOption.WithoutSpace:
			formattedLines = lines.map((line, idx) => `${opts.startLineOffset + idx}|${line}`);
			break;
		case xtabPromptOptions.IncludeLineNumbersOption.None:
			formattedLines = lines;
			break;
		default:
			assertNever(opts.includeLineNumbers);
	}

	const fileContent = formattedLines.join('\n');
	return [PromptTags.RECENT_FILE.start, firstLine, fileContent, PromptTags.RECENT_FILE.end].join('\n');
}

function getRecentCodeSnippets(
	activeDoc: StatelessNextEditDocument,
	xtabHistory: readonly IXtabHistoryEntry[],
	langCtx: LanguageContextResponse | undefined,
	computeTokens: (code: string) => number,
	opts: PromptOptions,
): {
	codeSnippets: string;
	documents: Set<DocumentId>;
} {

	const { includeViewedFiles, nDocuments } = opts.recentlyViewedDocuments;

	// get last documents besides active document
	// enforces the option to include/exclude viewed files
	const docsBesidesActiveDoc: IXtabHistoryEntry[] = []; // from most to least recent
	for (let i = xtabHistory.length - 1, seenDocuments = new Set<DocumentId>(); i >= 0; --i) {
		const entry = xtabHistory[i];

		if (!includeViewedFiles && entry.kind === 'visibleRanges') {
			continue;
		}

		if (entry.docId === activeDoc.id || seenDocuments.has(entry.docId)) {
			continue;
		}
		docsBesidesActiveDoc.push(entry);
		seenDocuments.add(entry.docId);
		if (docsBesidesActiveDoc.length >= nDocuments) {
			break;
		}
	}

	const recentlyViewedCodeSnippets = docsBesidesActiveDoc.map(d => ({
		id: d.docId,
		content:
			d.kind === 'edit'
				? d.edit.edit.applyOnText(d.edit.base) // FIXME@ulugbekna: I don't like this being computed afresh
				: d.documentContent,
		visibleRanges: d.kind === 'visibleRanges' ? d.visibleRanges : undefined, // is set only if the entry was a 'visibleRanges' entry
	}));

	const { snippets, docsInPrompt } = buildCodeSnippetsUsingPagedClipping(recentlyViewedCodeSnippets, computeTokens, opts);

	let tokenBudget = opts.languageContext.maxTokens;
	if (langCtx) {
		for (const langCtxEntry of langCtx.items) {
			// Context which is provided on timeout is not guranteed to be good context
			// TODO should these be included?
			if (langCtxEntry.onTimeout) {
				continue;
			}

			const ctx = langCtxEntry.context;
			// TODO@ulugbekna: currently we only include snippets
			// TODO@ulugbekna: are the snippets sorted by priority?
			if (ctx.kind === ContextKind.Snippet) {
				const langCtxSnippet = ctx.value;
				const potentialBudget = tokenBudget - computeTokens(langCtxSnippet);
				if (potentialBudget < 0) {
					break;
				}
				const filePath = ctx.uri;
				const documentId = DocumentId.create(filePath.toString());
				const langCtxItemSnippet = formatCodeSnippet(documentId, langCtxSnippet.split(/\r?\n/), { truncated: false, includeLineNumbers: opts.recentlyViewedDocuments.includeLineNumbers, startLineOffset: 0 });
				snippets.push(langCtxItemSnippet);
				tokenBudget = potentialBudget;
			}
		}
	}

	return {
		codeSnippets: snippets.join('\n\n'),
		documents: docsInPrompt,
	};
}

/**
 * Build code snippets using paged clipping.
 *
 * @param recentlyViewedCodeSnippets List of recently viewed code snippets from most to least recent
 */
export function buildCodeSnippetsUsingPagedClipping(
	recentlyViewedCodeSnippets: { id: DocumentId; content: StringText; visibleRanges?: readonly OffsetRange[] }[],
	computeTokens: (s: string) => number,
	opts: PromptOptions
): { snippets: string[]; docsInPrompt: Set<DocumentId> } {

	const pageSize = opts.pagedClipping?.pageSize;
	if (pageSize === undefined) {
		throw illegalArgument('Page size must be defined');
	}

	const snippets: string[] = [];
	const docsInPrompt = new Set<DocumentId>();

	let maxTokenBudget = opts.recentlyViewedDocuments.maxTokens;

	for (const file of recentlyViewedCodeSnippets) {
		const lines = file.content.getLines();
		const pages = batchArrayElements(lines, pageSize);

		// TODO@ulugbekna: we don't count in tokens for code snippet header

		if (file.visibleRanges === undefined) {
			let allowedBudget = maxTokenBudget;
			const linesToKeep: string[] = [];

			for (const page of pages) {
				const allowedBudgetLeft = allowedBudget - countTokensForLines(page, computeTokens);
				if (allowedBudgetLeft < 0) {
					break;
				}
				linesToKeep.push(...page);
				allowedBudget = allowedBudgetLeft;
			}

			if (linesToKeep.length > 0) {
				const isTruncated = linesToKeep.length !== lines.length;
				docsInPrompt.add(file.id);
				snippets.push(formatCodeSnippet(file.id, linesToKeep, { truncated: isTruncated, includeLineNumbers: opts.recentlyViewedDocuments.includeLineNumbers, startLineOffset: 0 }));
			}

			maxTokenBudget = allowedBudget;
		} else { // join visible ranges by taking a union, convert to lines, map those lines to pages, expand pages above and below as long as the new pages fit into the budget
			const visibleRanges = file.visibleRanges;
			const startOffset = Math.min(...visibleRanges.map(range => range.start));
			const endOffset = Math.max(...visibleRanges.map(range => range.endExclusive - 1));
			const contentTransform = file.content.getTransformer();
			const startPos = contentTransform.getPosition(startOffset);
			const endPos = contentTransform.getPosition(endOffset);

			const { firstPageIdx, lastPageIdxIncl, budgetLeft } = expandRangeToPageRange(
				file.content.getLines(),
				new OffsetRange(startPos.lineNumber - 1 /* convert from 1-based to 0-based */, endPos.lineNumber),
				pageSize,
				maxTokenBudget,
				computeTokens,
				false,
			);

			if (budgetLeft === maxTokenBudget) {
				break;
			} else {
				const startLineOffset = firstPageIdx * pageSize;
				const linesToKeep = file.content.getLines().slice(startLineOffset, (lastPageIdxIncl + 1) * pageSize);
				docsInPrompt.add(file.id);
				snippets.push(formatCodeSnippet(file.id, linesToKeep, { truncated: linesToKeep.length < lines.length, includeLineNumbers: opts.recentlyViewedDocuments.includeLineNumbers, startLineOffset }));
				maxTokenBudget = budgetLeft;
			}
		}
	}

	return { snippets: snippets.reverse(), docsInPrompt };
}

export function countTokensForLines(page: string[], computeTokens: (s: string) => number): number {
	return page.reduce((sum, line) => sum + computeTokens(line) + 1 /* \n */, 0);
}

/**
 * Last batch may not match batch size.
 */
function* batchArrayElements<T>(array: T[], batchSize: number): Iterable<T[]> {
	for (let i = 0; i < array.length; i += batchSize) {
		yield array.slice(i, i + batchSize);
	}
}

export function truncateCode(
	lines: string[],
	fromBeginning: boolean,
	maxTokens: number
): [number, number] {
	if (!lines.length) {
		return [0, 0];
	}

	const allowedLength = maxTokens * 4;
	let totalLength = 0;
	let i = fromBeginning ? lines.length - 1 : 0;

	while (totalLength < allowedLength) {
		totalLength += lines[i].length + 1; // +1 for \n
		if (fromBeginning) {
			i--;
			if (i < 0) {
				break;
			}
		} else {
			i++;
			if (i >= lines.length) {
				break;
			}
		}
	}

	if (fromBeginning) {
		return [i + 1, lines.length];
	} else {
		return [0, i];
	}
}

export const N_LINES_ABOVE = 2;
export const N_LINES_BELOW = 5;

export const N_LINES_AS_CONTEXT = 15;

export function expandRangeToPageRange(
	currentDocLines: string[],
	areaAroundEditWindowLinesRange: OffsetRange,
	pageSize: number,
	maxTokens: number,
	computeTokens: (s: string) => number,
	prioritizeAboveCursor: boolean,
): { firstPageIdx: number; lastPageIdxIncl: number; budgetLeft: number } {

	const totalNOfPages = Math.ceil(currentDocLines.length / pageSize);

	function computeTokensForPage(kthPage: number) {
		const start = kthPage * pageSize;
		const end = Math.min(start + pageSize, currentDocLines.length);
		const page = currentDocLines.slice(start, end);
		return countTokensForLines(page, computeTokens);
	}

	// [0, pageSize) -> 0, [pageSize, 2*pageSize) -> 1, ...
	// eg 5 -> 0, 63 -> 6
	let firstPageIdx = Math.floor(areaAroundEditWindowLinesRange.start / pageSize);
	let lastPageIdxIncl = Math.floor((areaAroundEditWindowLinesRange.endExclusive - 1) / pageSize);

	const availableTokenBudget = maxTokens - range(firstPageIdx, lastPageIdxIncl + 1).reduce((sum, idx) => sum + computeTokensForPage(idx), 0);
	if (availableTokenBudget < 0) {
		return { firstPageIdx, lastPageIdxIncl, budgetLeft: availableTokenBudget };
	}

	let tokenBudget = availableTokenBudget;

	// TODO: this's specifically implemented with some code duplication to not accidentally change existing behavior
	if (!prioritizeAboveCursor) { // both above and below get the half of budget
		const halfOfAvailableTokenBudget = Math.floor(availableTokenBudget / 2);

		tokenBudget = halfOfAvailableTokenBudget; // split by 2 to give both above and below areaAroundCode same budget

		for (let i = firstPageIdx - 1; i >= 0 && tokenBudget > 0; --i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			firstPageIdx = i;
			tokenBudget = newTokenBudget;
		}

		tokenBudget = halfOfAvailableTokenBudget;

		for (let i = lastPageIdxIncl + 1; i < totalNOfPages && tokenBudget > 0; ++i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			lastPageIdxIncl = i;
			tokenBudget = newTokenBudget;
		}
	} else { // code above consumes as much as it can and the leftover budget is given to code below
		tokenBudget = availableTokenBudget;

		for (let i = firstPageIdx - 1; i >= 0 && tokenBudget > 0; --i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			firstPageIdx = i;
			tokenBudget = newTokenBudget;
		}

		for (let i = lastPageIdxIncl + 1; i < totalNOfPages && tokenBudget > 0; ++i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			lastPageIdxIncl = i;
			tokenBudget = newTokenBudget;
		}
	}

	return { firstPageIdx, lastPageIdxIncl, budgetLeft: tokenBudget };
}

export function clipPreservingRange(
	docLines: string[],
	rangeToPreserve: OffsetRange,
	computeTokens: (s: string) => number,
	pageSize: number,
	opts: CurrentFileOptions,
): Result<OffsetRange, 'outOfBudget'> {

	// subtract budget consumed by rangeToPreserve
	const linesToPreserve = docLines.slice(rangeToPreserve.start, rangeToPreserve.endExclusive);
	const availableTokenBudget = opts.maxTokens - countTokensForLines(linesToPreserve, computeTokens);
	if (availableTokenBudget < 0) {
		return Result.error('outOfBudget');
	}

	const { firstPageIdx, lastPageIdxIncl } = expandRangeToPageRange(
		docLines,
		rangeToPreserve,
		pageSize,
		availableTokenBudget,
		computeTokens,
		opts.prioritizeAboveCursor,
	);

	const linesOffsetStart = firstPageIdx * pageSize;
	const linesOffsetEndExcl = (lastPageIdxIncl + 1) * pageSize;
	return Result.ok(new OffsetRange(linesOffsetStart, linesOffsetEndExcl));
}

class ClippedDocument {
	constructor(
		/** The lines of the document that were kept after clipping. */
		public readonly lines: string[],
		/** The range in the original document that corresponds to the kept lines. */
		public readonly keptRange: OffsetRange,
	) { }
}

export function createTaggedCurrentFileContentUsingPagedClipping(
	currentDocLines: string[],
	areaAroundCodeToEdit: string[],
	areaAroundEditWindowLinesRange: OffsetRange,
	computeTokens: (s: string) => number,
	pageSize: number,
	opts: CurrentFileOptions
): Result<ClippedDocument, 'outOfBudget'> {

	/*

	document:

	0 hello
	<edit window>
	1 world
	</edit window>
	2 foo

	cursor: line 1, offset 3 (between r and l)

	clipPreservingRange tries to include lines starting from the line with the cursor as long as token budget is not exceeded

	how it works:

	budget: 3

	1. try include line with the cursor - 2 tokens - ok, include it, remaining budget: 1
	2. try include line above - 2 tokens - not ok, don't include it, remaining budget: 1
	3. try include line below - 1 tokens - not ok, include it

	*/
	const r = clipPreservingRange(
		currentDocLines,
		areaAroundEditWindowLinesRange,
		computeTokens,
		pageSize,
		opts
	);

	if (r.isError()) {
		return r;
	}

	const rangeToKeep = r.val;

	const taggedCurrentFileContent = [
		...currentDocLines.slice(rangeToKeep.start, areaAroundEditWindowLinesRange.start),
		...areaAroundCodeToEdit,
		...currentDocLines.slice(areaAroundEditWindowLinesRange.endExclusive, rangeToKeep.endExclusive),
	];

	const keptRange = new OffsetRange(
		rangeToKeep.start,
		rangeToKeep.start + taggedCurrentFileContent.length
	);

	return Result.ok(new ClippedDocument(taggedCurrentFileContent, keptRange));
}

function addLineNumbers(lines: readonly string[], option: xtabPromptOptions.IncludeLineNumbersOption): string[] {
	switch (option) {
		case xtabPromptOptions.IncludeLineNumbersOption.WithSpaceAfter:
			return lines.map((line, idx) => `${idx}| ${line}`);
		case xtabPromptOptions.IncludeLineNumbersOption.WithoutSpace:
			return lines.map((line, idx) => `${idx}|${line}`);
		case xtabPromptOptions.IncludeLineNumbersOption.None:
			return [...lines];
		default:
			assertNever(option);
	}
}

export function constructTaggedFile(
	currentDocument: CurrentDocument,
	editWindowLinesRange: OffsetRange,
	areaAroundEditWindowLinesRange: OffsetRange,
	promptOptions: xtabPromptOptions.PromptOptions,
	computeTokens: (s: string) => number,
	opts: {
		includeLineNumbers: {
			areaAroundCodeToEdit: xtabPromptOptions.IncludeLineNumbersOption;
			currentFileContent: xtabPromptOptions.IncludeLineNumbersOption;
		};
	}
) {
	// Content with cursor tag - always created for areaAroundCodeToEdit
	const contentWithCursorAsLinesOriginal = (() => {
		const addCursorTagEdit = StringEdit.single(StringReplacement.insert(currentDocument.cursorOffset, PromptTags.CURSOR));
		const contentWithCursor = addCursorTagEdit.applyOnText(currentDocument.content);
		return contentWithCursor.getLines();
	})();

	const contentWithCursorAsLines = addLineNumbers(contentWithCursorAsLinesOriginal, opts.includeLineNumbers.areaAroundCodeToEdit);

	const editWindowWithCursorAsLines = contentWithCursorAsLines.slice(editWindowLinesRange.start, editWindowLinesRange.endExclusive);

	const areaAroundCodeToEdit = [
		PromptTags.AREA_AROUND.start,
		...contentWithCursorAsLines.slice(areaAroundEditWindowLinesRange.start, editWindowLinesRange.start),
		PromptTags.EDIT_WINDOW.start,
		...editWindowWithCursorAsLines,
		PromptTags.EDIT_WINDOW.end,
		...contentWithCursorAsLines.slice(editWindowLinesRange.endExclusive, areaAroundEditWindowLinesRange.endExclusive),
		PromptTags.AREA_AROUND.end
	];

	// For current file content, optionally include cursor tag based on includeCursorTag option
	const currentFileContentSourceLines = promptOptions.currentFile.includeCursorTag
		? contentWithCursorAsLinesOriginal
		: currentDocument.lines;
	const currentFileContentWithCursorLines = addLineNumbers(currentFileContentSourceLines, opts.includeLineNumbers.currentFileContent);
	const currentFileContentLines = addLineNumbers(currentDocument.lines, opts.includeLineNumbers.currentFileContent);

	let areaAroundCodeToEditForCurrentFile: string[];
	if (promptOptions.currentFile.includeTags && opts.includeLineNumbers.currentFileContent === opts.includeLineNumbers.areaAroundCodeToEdit) {
		areaAroundCodeToEditForCurrentFile = areaAroundCodeToEdit;
	} else {
		// Use currentFileContentWithCursorLines for edit window too
		const editWindowLines = currentFileContentWithCursorLines.slice(editWindowLinesRange.start, editWindowLinesRange.endExclusive);
		areaAroundCodeToEditForCurrentFile = [
			...currentFileContentWithCursorLines.slice(areaAroundEditWindowLinesRange.start, editWindowLinesRange.start),
			...editWindowLines,
			...currentFileContentWithCursorLines.slice(editWindowLinesRange.endExclusive, areaAroundEditWindowLinesRange.endExclusive),
		];
	}

	const taggedCurrentFileContentResult = createTaggedCurrentFileContentUsingPagedClipping(
		currentFileContentLines,
		areaAroundCodeToEditForCurrentFile,
		areaAroundEditWindowLinesRange,
		computeTokens,
		promptOptions.pagedClipping.pageSize,
		promptOptions.currentFile,
	);

	return taggedCurrentFileContentResult.map(clippedTaggedCurrentDoc => ({
		clippedTaggedCurrentDoc,
		areaAroundCodeToEdit: areaAroundCodeToEdit.join('\n'),
	}));
}
