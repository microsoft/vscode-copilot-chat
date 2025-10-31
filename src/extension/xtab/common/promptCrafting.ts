/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../platform/inlineEdits/common/dataTypes/edit';
import { LanguageContextResponse } from '../../../platform/inlineEdits/common/dataTypes/languageContext';
import { CurrentFileOptions, DiffHistoryOptions, PromptingStrategy, PromptOptions } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditDocument } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { IXtabHistoryEditEntry, IXtabHistoryEntry } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ContextKind, TraitContext } from '../../../platform/languageServer/common/languageContextService';
import { Result } from '../../../util/common/result';
import { pushMany, range } from '../../../util/vs/base/common/arrays';
import { illegalArgument } from '../../../util/vs/base/common/errors';
import { Schemas } from '../../../util/vs/base/common/network';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { PromptTags } from './tags';
import { CurrentDocument } from './xtabCurrentDocument';

export class PromptPieces {
	constructor(
		public readonly currentDocument: CurrentDocument,
		public readonly editWindowLinesRange: OffsetRange,
		public readonly areaAroundEditWindowLinesRange: OffsetRange,
		public readonly activeDoc: StatelessNextEditDocument,
		public readonly xtabHistory: readonly IXtabHistoryEntry[],
		public readonly currentFileContent: string,
		public readonly areaAroundCodeToEdit: string,
		public readonly langCtx: LanguageContextResponse | undefined,
		public readonly computeTokens: (s: string) => number,
		public readonly opts: PromptOptions,
	) {
	}
}

export function getUserPrompt(promptPieces: PromptPieces): string {

	const { activeDoc, xtabHistory, currentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, opts } = promptPieces;

	const { codeSnippets: recentlyViewedCodeSnippets, documents: docsInPrompt } = getRecentCodeSnippets(activeDoc, xtabHistory, langCtx, computeTokens, opts);

	docsInPrompt.add(activeDoc.id); // Add active document to the set of documents in prompt

	const editDiffHistory = getEditDiffHistory(activeDoc, xtabHistory, docsInPrompt, computeTokens, opts.diffHistory);

	const relatedInformation = getRelatedInformation(langCtx);

	const currentFilePath = toUniquePath(activeDoc.id, activeDoc.workspaceRoot?.path);

	const postScript = promptPieces.opts.includePostScript ? getPostScript(opts.promptingStrategy, currentFilePath) : '';

	const mainPrompt = `${PromptTags.RECENT_FILES.start}
${recentlyViewedCodeSnippets}
${PromptTags.RECENT_FILES.end}

${PromptTags.CURRENT_FILE.start}
current_file_path: ${currentFilePath}
${currentFileContent}
${PromptTags.CURRENT_FILE.end}

${PromptTags.EDIT_HISTORY.start}
${editDiffHistory}
${PromptTags.EDIT_HISTORY.end}

${areaAroundCodeToEdit}`;

	const includeBackticks = opts.promptingStrategy !== PromptingStrategy.Nes41Miniv3 && opts.promptingStrategy !== PromptingStrategy.Codexv21NesUnified;

	const prompt = relatedInformation + (includeBackticks ? wrapInBackticks(mainPrompt) : mainPrompt) + postScript;

	const trimmedPrompt = prompt.trim();

	return trimmedPrompt;
}

function wrapInBackticks(content: string) {
	return `\`\`\`\n${content}\n\`\`\``;
}

function getPostScript(strategy: PromptingStrategy | undefined, currentFilePath: string) {
	let postScript: string | undefined;
	switch (strategy) {
		case PromptingStrategy.Codexv21NesUnified:
			break;
		case PromptingStrategy.UnifiedModel:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Start your response with <EDIT>, <INSERT>, or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If you are inserting new code, start with <INSERT> and then provide only the new code that will be inserted at the cursor position followed by </INSERT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Nes41Miniv3:
			postScript = `The developer was working on a section of code within the tags <|code_to_edit|> in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`<|cursor|>\`, please continue the developer's work. Update the <|code_to_edit|> section by predicting and completing the changes they would have made next. Start your response with <EDIT> or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Xtab275:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags, but do not include the tags themselves. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors. Don't include the line numbers or the form #| in your response. Do not skip any lines. Do not be lazy.`;
			break;
		case PromptingStrategy.SimplifiedSystemPrompt:
		default:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. \
Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor \
position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes \
they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags with the following format, but do not include the tags themselves.
\`\`\`
// Your revised code goes here
\`\`\``;
			break;
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
		.filter(t => !t.onTimeout)
		.map(t => t.context) as TraitContext[];

	if (traits.length === 0) {
		return '';
	}

	const relatedInformation: string[] = [];
	for (const trait of traits) {
		relatedInformation.push(`${trait.name}: ${trait.value}`);
	}

	return `Consider this related information:\n${relatedInformation.join('\n')}\n\n`;
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

	let promptPiece = diffsFromOldestToNewest.join("\n\n");

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
	fileContent: string,
	truncate: boolean = false
): string {
	const filePath = toUniquePath(documentId, undefined);
	const firstLine = truncate
		? `code_snippet_file_path: ${filePath} (truncated)`
		: `code_snippet_file_path: ${filePath}`;
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
				const langCtxItemSnippet = formatCodeSnippet(documentId, ctx.value, false);
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
				snippets.push(formatCodeSnippet(file.id, linesToKeep.join('\n'), isTruncated));
			}

			maxTokenBudget = allowedBudget;
		} else { // join visible ranges by taking a union, convert to lines, map those lines to pages, expand pages above and below as long as the new pages fit into the budget
			const visibleRanges = file.visibleRanges;
			const startOffset = Math.min(...visibleRanges.map(range => range.start));
			const endOffset = Math.max(...visibleRanges.map(range => range.endExclusive - 1));
			const contentTransform = file.content.getTransformer();
			const startPos = contentTransform.getPosition(startOffset);
			const endPos = contentTransform.getPosition(endOffset);

			const { firstPageIdx, lastPageIdx, budgetLeft } = expandRangeToPageRange(
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
				const linesToKeep = file.content.getLines().slice(firstPageIdx * pageSize, (lastPageIdx + 1) * pageSize);
				docsInPrompt.add(file.id);
				snippets.push(formatCodeSnippet(file.id, linesToKeep.join('\n'), linesToKeep.length < lines.length));
				maxTokenBudget = budgetLeft;
			}
		}
	}

	return { snippets: snippets.reverse(), docsInPrompt };
}

function countTokensForLines(page: string[], computeTokens: (s: string) => number): number {
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

function expandRangeToPageRange(
	currentDocLines: string[],
	areaAroundEditWindowLinesRange: OffsetRange,
	pageSize: number,
	maxTokens: number,
	computeTokens: (s: string) => number,
	prioritizeAboveCursor: boolean,
): { firstPageIdx: number; lastPageIdx: number; budgetLeft: number } {

	const totalNOfPages = Math.ceil(currentDocLines.length / pageSize);

	function computeTokensForPage(kthPage: number) {
		const start = kthPage * pageSize;
		const end = Math.min(start + pageSize, currentDocLines.length);
		const page = currentDocLines.slice(start, end);
		return countTokensForLines(page, computeTokens);
	}
	let firstPageIdx = Math.floor(areaAroundEditWindowLinesRange.start / pageSize);
	let lastPageIdx = Math.floor((areaAroundEditWindowLinesRange.endExclusive - 1) / pageSize);

	const availableTokenBudget = maxTokens - range(firstPageIdx, lastPageIdx + 1).reduce((sum, idx) => sum + computeTokensForPage(idx), 0);
	if (availableTokenBudget < 0) {
		return { firstPageIdx, lastPageIdx, budgetLeft: availableTokenBudget };
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

		for (let i = lastPageIdx + 1; i <= totalNOfPages && tokenBudget > 0; ++i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			lastPageIdx = i;
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

		for (let i = lastPageIdx + 1; i <= totalNOfPages && tokenBudget > 0; ++i) {
			const tokenCountForPage = computeTokensForPage(i);
			const newTokenBudget = tokenBudget - tokenCountForPage;
			if (newTokenBudget < 0) {
				break;
			}
			lastPageIdx = i;
			tokenBudget = newTokenBudget;
		}
	}

	return { firstPageIdx, lastPageIdx, budgetLeft: tokenBudget };
}

export function clipPreservingRange(
	docLines: string[],
	rangeToPreserve: OffsetRange,
	computeTokens: (s: string) => number,
	pageSize: number,
	opts: CurrentFileOptions,
): Result<OffsetRange, 'outOfBudget'> {

	// subtract budget consumed by rangeToPreserve
	const availableTokenBudget = opts.maxTokens - countTokensForLines(docLines.slice(rangeToPreserve.start, rangeToPreserve.endExclusive), computeTokens);
	if (availableTokenBudget < 0) {
		return Result.error('outOfBudget');
	}

	const { firstPageIdx, lastPageIdx } = expandRangeToPageRange(
		docLines,
		rangeToPreserve,
		pageSize,
		availableTokenBudget,
		computeTokens,
		opts.prioritizeAboveCursor,
	);

	const linesOffsetStart = firstPageIdx * pageSize;
	const linesOffsetEndExcl = lastPageIdx * pageSize + pageSize;

	return Result.ok(new OffsetRange(linesOffsetStart, linesOffsetEndExcl));
}

export function createTaggedCurrentFileContentUsingPagedClipping(
	currentDocLines: string[],
	areaAroundCodeToEdit: string,
	areaAroundEditWindowLinesRange: OffsetRange,
	computeTokens: (s: string) => number,
	pageSize: number,
	opts: CurrentFileOptions
): Result<{ taggedCurrentFileContent: string; nLines: number }, 'outOfBudget'> {

	const r = clipPreservingRange(
		currentDocLines,
		areaAroundEditWindowLinesRange,
		computeTokens,
		pageSize,
		opts
	);

	if (r.isError()) {
		return Result.error('outOfBudget');
	}

	const clippedRange = r.val;

	const taggedCurrentFileContent = [
		...currentDocLines.slice(clippedRange.start, areaAroundEditWindowLinesRange.start),
		areaAroundCodeToEdit,
		...currentDocLines.slice(areaAroundEditWindowLinesRange.endExclusive, clippedRange.endExclusive),
	];

	return Result.ok({ taggedCurrentFileContent: taggedCurrentFileContent.join('\n'), nLines: taggedCurrentFileContent.length });
}
