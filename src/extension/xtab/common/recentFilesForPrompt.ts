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


function formatCodeSnippet(
	documentId: DocumentId,
	lines: string[],
	opts: { truncated: boolean; includeLineNumbers: xtabPromptOptions.IncludeLineNumbersOption; startLineOffset: number }
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

export function getRecentCodeSnippets(
	activeDoc: StatelessNextEditDocument,
	xtabHistory: readonly IXtabHistoryEntry[],
	langCtx: LanguageContextResponse | undefined,
	computeTokens: (code: string) => number,
	opts: PromptOptions,
): { codeSnippets: string; documents: Set<DocumentId> } {

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
		content: d.kind === 'edit'
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
				false
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

