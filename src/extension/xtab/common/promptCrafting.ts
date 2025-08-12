/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../platform/inlineEdits/common/dataTypes/edit';
import { LanguageContextResponse } from '../../../platform/inlineEdits/common/dataTypes/languageContext';
import { CurrentFileOptions, DiffHistoryOptions, PromptingStrategy, PromptOptions } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditRequest } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { IXtabHistoryEditEntry, IXtabHistoryEntry } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ContextKind } from '../../../platform/languageServer/common/languageContextService';
import { range } from '../../../util/vs/base/common/arrays';
import { illegalArgument } from '../../../util/vs/base/common/errors';
import { Schemas } from '../../../util/vs/base/common/network';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';

export const CURSOR_TAG = "<|cursor|>";
export const CODE_TO_EDIT_START_TAG = "<|code_to_edit|>";
export const CODE_TO_EDIT_END_TAG = "<|/code_to_edit|>";

export const AREA_AROUND_START_TAG = "<|area_around_code_to_edit|>";
export const AREA_AROUND_END_TAG = "<|/area_around_code_to_edit|>";
export const CURRENT_FILE_CONTENT_START_TAG = "<|current_file_content|>";
export const CURRENT_FILE_CONTENT_END_TAG = "<|/current_file_content|>";
export const EDIT_DIFF_HISTORY_START_TAG = "<|edit_diff_history|>";
export const EDIT_DIFF_HISTORY_END_TAG = "<|/edit_diff_history|>";
export const RECENTLY_VIEWED_CODE_SNIPPETS_START = "<|recently_viewed_code_snippets|>";
export const RECENTLY_VIEWED_CODE_SNIPPETS_END = "<|/recently_viewed_code_snippets|>";
export const CODE_SNIPPET_START = "<|recently_viewed_code_snippet|>";
export const CODE_SNIPPET_END = "<|/recently_viewed_code_snippet|>";

export const systemPromptTemplate = `Your role as an AI assistant is to help developers complete their code tasks by assisting in editing specific sections of code marked by the ${CODE_TO_EDIT_START_TAG} and ${CODE_TO_EDIT_END_TAG} tags, while adhering to Microsoft's content policies and avoiding the creation of content that violates copyrights.

You have access to the following information to help you make informed suggestions:

- recently_viewed_code_snippets: These are code snippets that the developer has recently looked at, which might provide context or examples relevant to the current task. They are listed from oldest to newest, with line numbers in the form #| to help you understand the edit diff history. It's possible these are entirely irrelevant to the developer's change.
- current_file_content: The content of the file the developer is currently working on, providing the broader context of the code. Line numbers in the form #| are included to help you understand the edit diff history.
- edit_diff_history: A record of changes made to the code, helping you understand the evolution of the code and the developer's intentions. These changes are listed from oldest to latest. It's possible a lot of old edit diff history is entirely irrelevant to the developer's change.
- area_around_code_to_edit: The context showing the code surrounding the section to be edited.
- cursor position marked as ${CURSOR_TAG}: Indicates where the developer's cursor is currently located, which can be crucial for understanding what part of the code they are focusing on.

Your task is to predict and complete the changes the developer would have made next in the ${CODE_TO_EDIT_START_TAG} section. The developer may have stopped in the middle of typing. Your goal is to keep the developer on the path that you think they're following. Some examples include further implementing a class, method, or variable, or improving the quality of the code. Make sure the developer doesn't get distracted and ensure your suggestion is relevant. Consider what changes need to be made next, if any. If you think changes should be made, ask yourself if this is truly what needs to happen. If you are confident about it, then proceed with the changes.

# Steps

1. **Review Context**: Analyze the context from the resources provided, such as recently viewed snippets, edit history, surrounding code, and cursor location.
2. **Evaluate Current Code**: Determine if the current code within the tags requires any corrections or enhancements.
3. **Suggest Edits**: If changes are required, ensure they align with the developer's patterns and improve code quality.
4. **Maintain Consistency**: Ensure indentation and formatting follow the existing code style.

# Output Format

- Provide only the revised code within the tags. If no changes are necessary, simply return the original code from within the ${CODE_TO_EDIT_START_TAG} and ${CODE_TO_EDIT_END_TAG} tags.
- There are line numbers in the form #| in the code displayed to you above, but these are just for your reference. Please do not include the numbers of the form #| in your response.
- Ensure that you do not output duplicate code that exists outside of these tags. The output should be the revised code that was between these tags and should not include the ${CODE_TO_EDIT_START_TAG} or ${CODE_TO_EDIT_END_TAG} tags.

\`\`\`
// Your revised code goes here
\`\`\`

# Notes

- Apologize with "Sorry, I can't assist with that." for requests that may breach Microsoft content guidelines.
- Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.
- Don't include the line numbers of the form #| in your response.`;

export const unifiedModelSystemPrompt = `Your role as an AI assistant is to help developers complete their code tasks by assisting in editing specific sections of code marked by the <|code_to_edit|> and <|/code_to_edit|> tags, while adhering to Microsoft's content policies and avoiding the creation of content that violates copyrights.

You have access to the following information to help you make informed suggestions:

- recently_viewed_code_snippets: These are code snippets that the developer has recently looked at, which might provide context or examples relevant to the current task. They are listed from oldest to newest. It's possible these are entirely irrelevant to the developer's change.
- current_file_content: The content of the file the developer is currently working on, providing the broader context of the code.
- edit_diff_history: A record of changes made to the code, helping you understand the evolution of the code and the developer's intentions. These changes are listed from oldest to latest. It's possible a lot of old edit diff history is entirely irrelevant to the developer's change.
- area_around_code_to_edit: The context showing the code surrounding the section to be edited.
- cursor position marked as <|cursor|>: Indicates where the developer's cursor is currently located, which can be crucial for understanding what part of the code they are focusing on.

Your task is to predict and complete the changes the developer would have made next in the <|code_to_edit|> section. The developer may have stopped in the middle of typing. Your goal is to keep the developer on the path that you think they're following. Some examples include further implementing a class, method, or variable, or improving the quality of the code. Make sure the developer doesn't get distracted and ensure your suggestion is relevant. Consider what changes need to be made next, if any. If you think changes should be made, ask yourself if this is truly what needs to happen. If you are confident about it, then proceed with the changes.

# Steps

1. **Review Context**: Analyze the context from the resources provided, such as recently viewed snippets, edit history, surrounding code, and cursor location.
2. **Evaluate Current Code**: Determine if the current code within the tags requires any corrections or enhancements.
3. **Suggest Edits**: If changes are required, ensure they align with the developer's patterns and improve code quality.
4. **Maintain Consistency**: Ensure indentation and formatting follow the existing code style.

# Output Format
- Your response should start with the word <EDIT>, <INSERT>, or <NO_CHANGE>.
- If your are making an edit, start with <EDIT>, then provide the rewritten code window, then </EDIT>.
- If you are inserting new code, start with <INSERT> and then provide only the new code that will be inserted at the cursor position, then </INSERT>.
- If no changes are necessary, reply only with <NO_CHANGE>.
- Ensure that you do not output duplicate code that exists outside of these tags. The output should be the revised code that was between these tags and should not include the <|code_to_edit|> or <|/code_to_edit|> tags.

# Notes

- Apologize with "Sorry, I can't assist with that." for requests that may breach Microsoft content guidelines.
- Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;

export const nes41Miniv3SystemPrompt = `Your role as an AI assistant is to help developers complete their code tasks by assisting in editing specific sections of code marked by the <|code_to_edit|> and <|/code_to_edit|> tags, while adhering to Microsoft's content policies and avoiding the creation of content that violates copyrights.

You have access to the following information to help you make informed suggestions:

- recently_viewed_code_snippets: These are code snippets that the developer has recently looked at, which might provide context or examples relevant to the current task. They are listed from oldest to newest. It's possible these are entirely irrelevant to the developer's change.
- current_file_content: The content of the file the developer is currently working on, providing the broader context of the code.
- edit_diff_history: A record of changes made to the code, helping you understand the evolution of the code and the developer's intentions. These changes are listed from oldest to latest. It's possible a lot of old edit diff history is entirely irrelevant to the developer's change.
- area_around_code_to_edit: The context showing the code surrounding the section to be edited.
- cursor position marked as <|cursor|>: Indicates where the developer's cursor is currently located, which can be crucial for understanding what part of the code they are focusing on.

Your task is to predict and complete the changes the developer would have made next in the <|code_to_edit|> section. The developer may have stopped in the middle of typing. Your goal is to keep the developer on the path that you think they're following. Some examples include further implementing a class, method, or variable, or improving the quality of the code. Make sure the developer doesn't get distracted and ensure your suggestion is relevant. Consider what changes need to be made next, if any. If you think changes should be made, ask yourself if this is truly what needs to happen. If you are confident about it, then proceed with the changes.

# Steps

1. **Review Context**: Analyze the context from the resources provided, such as recently viewed snippets, edit history, surrounding code, and cursor location.
2. **Evaluate Current Code**: Determine if the current code within the tags requires any corrections or enhancements.
3. **Suggest Edits**: If changes are required, ensure they align with the developer's patterns and improve code quality.
4. **Maintain Consistency**: Ensure indentation and formatting follow the existing code style.

# Output Format
- Your response should start with the word <EDIT> or <NO_CHANGE>.
- If your are making an edit, start with <EDIT>, then provide the rewritten code window, then </EDIT>.
- If no changes are necessary, reply only with <NO_CHANGE>.
- Ensure that you do not output duplicate code that exists outside of these tags. The output should be the revised code that was between these tags and should not include the <|code_to_edit|> or <|/code_to_edit|> tags.

# Notes

- Apologize with "Sorry, I can't assist with that." for requests that may breach Microsoft content guidelines.
- Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;

export const simplifiedPrompt = 'Predict next code edit based on the context given by the user.';

export const xtab275SystemPrompt = `Predict the next code edit based on user context, following Microsoft content policies and avoiding copyright violations. If a request may breach guidelines, reply: "Sorry, I can't assist with that."`;

export function getUserPrompt(request: StatelessNextEditRequest, currentFileContent: string, areaAroundCodeToEdit: string, langCtx: LanguageContextResponse | undefined, computeTokens: (s: string) => number, opts: PromptOptions): string {

	const activeDoc = request.getActiveDocument();

	const { codeSnippets: recentlyViewedCodeSnippets, documents: docsInPrompt } = getRecentCodeSnippets(request, langCtx, computeTokens, opts);

	docsInPrompt.add(activeDoc.id); // Add active document to the set of documents in prompt

	const editDiffHistory = getEditDiffHistory(request, docsInPrompt, computeTokens, opts.diffHistory);

	const currentFilePath = toUniquePath(activeDoc.id, activeDoc.workspaceRoot?.path);

	const postScript = getPostScript(opts.promptingStrategy, currentFilePath);

	const mainPrompt = `${RECENTLY_VIEWED_CODE_SNIPPETS_START}
${recentlyViewedCodeSnippets}
${RECENTLY_VIEWED_CODE_SNIPPETS_END}

${CURRENT_FILE_CONTENT_START_TAG}
current_file_path: ${currentFilePath}
${currentFileContent}
${CURRENT_FILE_CONTENT_END_TAG}

${EDIT_DIFF_HISTORY_START_TAG}
${editDiffHistory}
${EDIT_DIFF_HISTORY_END_TAG}

${areaAroundCodeToEdit}`;

	const includeBackticks = opts.promptingStrategy !== PromptingStrategy.Nes41Miniv3 && opts.promptingStrategy !== PromptingStrategy.Codexv21NesUnified;

	const prompt = (includeBackticks ? wrapInBackticks(mainPrompt) : mainPrompt) + postScript;

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
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${CURSOR_TAG}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Start your response with <EDIT>, <INSERT>, or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If you are inserting new code, start with <INSERT> and then provide only the new code that will be inserted at the cursor position followed by </INSERT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Nes41Miniv3:
			postScript = `The developer was working on a section of code within the tags <|code_to_edit|> in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`<|cursor|>\`, please continue the developer's work. Update the <|code_to_edit|> section by predicting and completing the changes they would have made next. Start your response with <EDIT> or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
			break;
		case PromptingStrategy.Xtab275:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${CURSOR_TAG}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`${CODE_TO_EDIT_START_TAG}\` and \`${CODE_TO_EDIT_END_TAG}\` tags, but do not include the tags themselves. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors. Don't include the line numbers or the form #| in your response. Do not skip any lines. Do not be lazy.`;
			break;
		case PromptingStrategy.SimplifiedSystemPrompt:
		default:
			postScript = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. \
Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor \
position marked as \`${CURSOR_TAG}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes \
they would have made next. Provide the revised code that was between the \`${CODE_TO_EDIT_START_TAG}\` and \`${CODE_TO_EDIT_END_TAG}\` tags with the following format, but do not include the tags themselves.
\`\`\`
// Your revised code goes here
\`\`\``;
			break;
	}

	const formattedPostScript = postScript === undefined ? '' : `\n\n${postScript}`;
	return formattedPostScript;
}

function getEditDiffHistory(
	request: StatelessNextEditRequest,
	docsInPrompt: Set<DocumentId>,
	computeTokens: (s: string) => number,
	{ onlyForDocsInPrompt, maxTokens, nEntries, useRelativePaths }: DiffHistoryOptions
) {
	const workspacePath = useRelativePaths ? request.getActiveDocument().workspaceRoot?.path : undefined;

	let tokenBudget = maxTokens;

	const allDiffs: string[] = [];

	// we traverse in reverse (ie from most recent to least recent) because we may terminate early due to token-budget overflow
	for (const entry of request.xtabEditHistory.reverse()) {
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

	for (const singleLineEdit of lineEdit.edits) {
		const oldLines = entry.edit.base.getLines().slice(singleLineEdit.lineRange.startLineNumber - 1, singleLineEdit.lineRange.endLineNumberExclusive - 1);
		const newLines = singleLineEdit.newLines;

		if (oldLines.filter(x => x.trim().length > 0).length === 0 && newLines.filter(x => x.trim().length > 0).length === 0) {
			// skip over a diff which would only contain -/+ without any content
			continue;
		}

		const startLineNumber = singleLineEdit.lineRange.startLineNumber - 1;

		docDiffLines.push(`@@ -${startLineNumber},${oldLines.length} +${startLineNumber},${newLines.length} @@`);
		docDiffLines.push(...oldLines.map(x => `-${x}`));
		docDiffLines.push(...newLines.map(x => `+${x}`));
	}

	if (docDiffLines.length === 0) {
		return null;
	}

	const uniquePath = toUniquePath(entry.docId, workspacePath);

	const docDiff = [
		`--- ${uniquePath}`,
		`+++ ${uniquePath}`,
		...docDiffLines
	].join('\n');

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
	return [CODE_SNIPPET_START, firstLine, fileContent, CODE_SNIPPET_END].join('\n');
}

function getRecentCodeSnippets(
	request: StatelessNextEditRequest,
	langCtx: LanguageContextResponse | undefined,
	computeTokens: (code: string) => number,
	opts: PromptOptions,
): {
	codeSnippets: string;
	documents: Set<DocumentId>;
} {

	const { includeViewedFiles, nDocuments } = opts.recentlyViewedDocuments;

	const activeDoc = request.getActiveDocument();

	// get last documents besides active document
	// enforces the option to include/exclude viewed files
	const docsBesidesActiveDoc: IXtabHistoryEntry[] = []; // from most to least recent
	for (let i = request.xtabEditHistory.length - 1, seenDocuments = new Set<DocumentId>(); i >= 0; --i) {
		const entry = request.xtabEditHistory[i];

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

/**
 * @remark exported for testing
 */
export function createTaggedCurrentFileContentUsingPagedClipping(
	currentDocLines: string[],
	areaAroundCodeToEdit: string,
	areaAroundEditWindowLinesRange: OffsetRange,
	computeTokens: (s: string) => number,
	pageSize: number,
	opts: CurrentFileOptions
): { taggedCurrentFileContent: string; nLines: number } {

	// subtract budget consumed by areaAroundCodeToEdit
	const availableTokenBudget = opts.maxTokens - countTokensForLines(areaAroundCodeToEdit.split(/\r?\n/), computeTokens);

	const { firstPageIdx, lastPageIdx } = expandRangeToPageRange(
		currentDocLines,
		areaAroundEditWindowLinesRange,
		pageSize,
		availableTokenBudget,
		computeTokens,
		opts.prioritizeAboveCursor,
	);

	const linesOffsetStart = firstPageIdx * pageSize;
	const linesOffsetEnd = lastPageIdx * pageSize + pageSize;

	const taggedCurrentFileContent = [
		...currentDocLines.slice(linesOffsetStart, areaAroundEditWindowLinesRange.start),
		areaAroundCodeToEdit,
		...currentDocLines.slice(areaAroundEditWindowLinesRange.endExclusive, linesOffsetEnd),
	];

	return { taggedCurrentFileContent: taggedCurrentFileContent.join('\n'), nLines: taggedCurrentFileContent.length };
}
