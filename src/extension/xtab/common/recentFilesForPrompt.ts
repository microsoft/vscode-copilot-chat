/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageContextResponse } from '../../../platform/inlineEdits/common/dataTypes/languageContext';
import * as xtabPromptOptions from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { PromptOptions } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditDocument } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { IXtabHistoryEntry } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ContextKind } from '../../../platform/languageServer/common/languageContextService';
import { batchArrayElements } from '../../../util/common/arrays';
import { assertNever } from '../../../util/vs/base/common/assert';
import { illegalArgument } from '../../../util/vs/base/common/errors';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { expandRangeToPageRange } from './promptCrafting';
import { countTokensForLines, toUniquePath } from './promptCraftingUtils';
import { PromptTags } from './tags';

export function getRecentCodeSnippets(
	activeDoc: StatelessNextEditDocument,
	xtabHistory: readonly IXtabHistoryEntry[],
	langCtx: LanguageContextResponse | undefined,
	computeTokens: (code: string) => number,
	opts: PromptOptions,
): { codeSnippets: string; documents: Set<DocumentId> } {

	const { includeViewedFiles, nDocuments } = opts.recentlyViewedDocuments;

	const docsBesidesActiveDoc = collectRecentDocuments(xtabHistory, activeDoc.id, includeViewedFiles, nDocuments);
	const recentlyViewedCodeSnippets = docsBesidesActiveDoc.map(historyEntryToCodeSnippet);

	const { snippets, docsInPrompt } = buildCodeSnippetsUsingPagedClipping(recentlyViewedCodeSnippets, computeTokens, opts);

	if (langCtx) {
		appendLanguageContextSnippets(langCtx, snippets, opts.languageContext.maxTokens, computeTokens, opts.recentlyViewedDocuments.includeLineNumbers);
	}

	return {
		codeSnippets: snippets.join('\n\n'),
		documents: docsInPrompt,
	};
}

function formatLinesWithLineNumbers(
	lines: string[],
	includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption,
	startLineOffset: number,
): string[] {
	switch (includeLineNumbers) {
		case xtabPromptOptions.IncludeLineNumbersOption.WithSpaceAfter:
			return lines.map((line, idx) => `${startLineOffset + idx}| ${line}`);
		case xtabPromptOptions.IncludeLineNumbersOption.WithoutSpace:
			return lines.map((line, idx) => `${startLineOffset + idx}|${line}`);
		case xtabPromptOptions.IncludeLineNumbersOption.None:
			return lines;
		default:
			assertNever(includeLineNumbers);
	}
}

function formatCodeSnippet(
	documentId: DocumentId,
	lines: string[],
	opts: { truncated: boolean; includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption; startLineOffset: number }
): string {
	const filePath = toUniquePath(documentId, undefined);
	const firstLine = opts.truncated
		? `code_snippet_file_path: ${filePath} (truncated)`
		: `code_snippet_file_path: ${filePath}`;

	const formattedLines = formatLinesWithLineNumbers(lines, opts.includeLineNumbers, opts.startLineOffset);
	const fileContent = formattedLines.join('\n');
	return [PromptTags.RECENT_FILE.start, firstLine, fileContent, PromptTags.RECENT_FILE.end].join('\n');
}

/**
 * Collect last `nDocuments` unique documents from xtab history, excluding the active document.
 * Returns entries from most to least recent.
 */
function collectRecentDocuments(
	xtabHistory: readonly IXtabHistoryEntry[],
	activeDocId: DocumentId,
	includeViewedFiles: boolean,
	nDocuments: number,
): IXtabHistoryEntry[] {
	const result: IXtabHistoryEntry[] = [];
	const seenDocuments = new Set<DocumentId>();

	for (let i = xtabHistory.length - 1; i >= 0; --i) {
		const entry = xtabHistory[i];

		if (!includeViewedFiles && entry.kind === 'visibleRanges') {
			continue;
		}

		if (entry.docId === activeDocId || seenDocuments.has(entry.docId)) {
			continue;
		}
		result.push(entry);
		seenDocuments.add(entry.docId);
		if (result.length >= nDocuments) {
			break;
		}
	}

	return result;
}

function historyEntryToCodeSnippet(d: IXtabHistoryEntry): { id: DocumentId; content: StringText; visibleRanges?: readonly OffsetRange[] } {
	return {
		id: d.docId,
		content: d.kind === 'edit'
			? d.edit.edit.applyOnText(d.edit.base) // FIXME@ulugbekna: I don't like this being computed afresh
			: d.documentContent,
		visibleRanges: d.kind === 'visibleRanges' ? d.visibleRanges : undefined, // is set only if the entry was a 'visibleRanges' entry
	};
}

/**
 * Append language context snippets to the snippets array, respecting the token budget.
 */
function appendLanguageContextSnippets(
	langCtx: LanguageContextResponse,
	snippets: string[],
	tokenBudget: number,
	computeTokens: (code: string) => number,
	includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption,
): void {
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
			const documentId = DocumentId.create(ctx.uri.toString());
			snippets.push(formatCodeSnippet(documentId, langCtxSnippet.split(/\r?\n/), { truncated: false, includeLineNumbers, startLineOffset: 0 }));
			tokenBudget = potentialBudget;
		}
	}
}

/**
 * Clip a file without visible ranges by taking pages from the start until budget is exhausted.
 *
 * @returns The remaining token budget after clipping.
 */
function clipFullDocument(
	document: { id: DocumentId; content: StringText },
	pages: Iterable<string[]>,
	totalLineCount: number,
	tokenBudget: number,
	computeTokens: (s: string) => number,
	includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption,
	result: { snippets: string[]; docsInPrompt: Set<DocumentId> },
): number {
	let allowedBudget = tokenBudget;
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
		const isTruncated = linesToKeep.length !== totalLineCount;
		result.docsInPrompt.add(document.id);
		result.snippets.push(formatCodeSnippet(document.id, linesToKeep, { truncated: isTruncated, includeLineNumbers, startLineOffset: 0 }));
	}

	return allowedBudget;
}

/**
 * Clip a file around its visible ranges by expanding pages outward until budget is exhausted.
 *
 * @returns The remaining token budget after clipping, or `undefined` if nothing fit into the budget.
 */
function clipAroundVisibleRanges(
	document: { id: DocumentId; content: StringText; visibleRanges: readonly OffsetRange[] },
	pageSize: number,
	totalLineCount: number,
	tokenBudget: number,
	computeTokens: (s: string) => number,
	includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption,
	result: { snippets: string[]; docsInPrompt: Set<DocumentId> },
): number | undefined {
	const startOffset = Math.min(...document.visibleRanges.map(range => range.start));
	const endOffset = Math.max(...document.visibleRanges.map(range => range.endExclusive - 1));
	const contentTransform = document.content.getTransformer();
	const startPos = contentTransform.getPosition(startOffset);
	const endPos = contentTransform.getPosition(endOffset);

	const { firstPageIdx, lastPageIdxIncl, budgetLeft } = expandRangeToPageRange(
		document.content.getLines(),
		new OffsetRange(startPos.lineNumber - 1 /* convert from 1-based to 0-based */, endPos.lineNumber),
		pageSize,
		tokenBudget,
		computeTokens,
		false
	);

	if (budgetLeft === tokenBudget) {
		return undefined; // nothing fit — signal caller to stop
	}

	const startLineOffset = firstPageIdx * pageSize;
	const linesToKeep = document.content.getLines().slice(startLineOffset, (lastPageIdxIncl + 1) * pageSize);
	result.docsInPrompt.add(document.id);
	result.snippets.push(formatCodeSnippet(document.id, linesToKeep, { truncated: linesToKeep.length < totalLineCount, includeLineNumbers, startLineOffset }));
	return budgetLeft;
}

/**
 * Build code snippets using paged clipping.
 *
 * @param recentlyViewedCodeSnippets List of recently viewed code snippets from most to least recent
 */
export function buildCodeSnippetsUsingPagedClipping(
	recentlyViewedCodeSnippets: { id: DocumentId; content: StringText; visibleRanges?: readonly OffsetRange[] }[],
	computeTokens: (s: string) => number,
	opts: PromptOptions,
): { snippets: string[]; docsInPrompt: Set<DocumentId> } {

	const pageSize = opts.pagedClipping?.pageSize;
	if (pageSize === undefined) {
		throw illegalArgument('Page size must be defined');
	}

	const result: { snippets: string[]; docsInPrompt: Set<DocumentId> } = {
		snippets: [],
		docsInPrompt: new Set<DocumentId>(),
	};

	let maxTokenBudget = opts.recentlyViewedDocuments.maxTokens;
	const includeLineNumbers = opts.recentlyViewedDocuments.includeLineNumbers;

	for (const file of recentlyViewedCodeSnippets) {
		const lines = file.content.getLines();

		// TODO@ulugbekna: we don't count in tokens for code snippet header
		if (file.visibleRanges === undefined) {
			const pages = batchArrayElements(lines, pageSize);
			maxTokenBudget = clipFullDocument(file, pages, lines.length, maxTokenBudget, computeTokens, includeLineNumbers, result);
		} else {
			// join visible ranges by taking a union, convert to lines, map those lines to pages,
			// expand pages above and below as long as the new pages fit into the budget
			const budgetLeft = clipAroundVisibleRanges(file as { id: DocumentId; content: StringText; visibleRanges: readonly OffsetRange[] }, pageSize, lines.length, maxTokenBudget, computeTokens, includeLineNumbers, result);
			if (budgetLeft === undefined) {
				break;
			}
			maxTokenBudget = budgetLeft;
		}
	}

	return { snippets: result.snippets.reverse(), docsInPrompt: result.docsInPrompt };
}

