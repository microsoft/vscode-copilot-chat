/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../context';
import { ResolvedContextItem } from '../contextProviderRegistry';
import { ContextProviderStatistics, PromptExpectation } from '../contextProviderStatistics';
import { CodeSnippetWithId, filterContextItemsByType } from './contextItemSchemas';
import { TextDocumentValidation } from '../../textDocument';
import { TextDocumentManager } from '../../textDocumentManager';

const CONTENT_EXCLUDED_EXPECTATION: PromptExpectation = 'content_excluded';

type SnippetWithProviderInfo = {
	providerId: string;
	data: CodeSnippetWithId;
};

export async function getCodeSnippetsFromContextItems(
	ctx: Context,
	completionId: string,
	resolvedContextItems: ResolvedContextItem[],
	languageId: string
): Promise<CodeSnippetWithId[]> {
	const codeSnippetContextItems = filterContextItemsByType(resolvedContextItems, 'CodeSnippet');

	if (codeSnippetContextItems.length === 0) {
		return [];
	}

	// Expand snippets and collect URIs
	const allUris = new Set<string>();
	const mappedSnippets: SnippetWithProviderInfo[] = codeSnippetContextItems.flatMap(item =>
		item.data.map(data => {
			allUris.add(data.uri);
			data.additionalUris?.forEach(uri => allUris.add(uri));
			return { providerId: item.providerId, data };
		})
	);

	// Validate all URIs at once: we already know they are distinct
	const tdm = ctx.get(TextDocumentManager);
	const validationMap = new Map<string, TextDocumentValidation>();
	await Promise.all(
		Array.from(allUris).map(async uri => {
			validationMap.set(uri, await tdm.getTextDocumentValidation({ uri }));
		})
	);

	// Process only valid snippets
	const statistics = ctx.get(ContextProviderStatistics).getStatisticsForCompletion(completionId);
	return mappedSnippets
		.filter(snippet => {
			const urisToCheck = [snippet.data.uri, ...(snippet.data.additionalUris ?? [])];
			const isValid = urisToCheck.every(uri => validationMap.get(uri)?.status === 'valid');

			// Set expectations regardless of validity
			if (isValid) {
				statistics.addExpectations(snippet.providerId, [[snippet.data, 'included']]);
			} else {
				statistics.addExpectations(snippet.providerId, [[snippet.data, CONTENT_EXCLUDED_EXPECTATION]]);
			}

			return isValid;
		})
		.map(snippet => snippet.data);
}

export type CodeSnippetWithRelativePath = { snippet: CodeSnippetWithId; relativePath?: string };

export function addRelativePathToCodeSnippets(
	ctx: Context,
	codeSnippets: CodeSnippetWithId[]
): CodeSnippetWithRelativePath[] {
	const tdm = ctx.get(TextDocumentManager);
	return codeSnippets.map(codeSnippet => {
		return {
			snippet: codeSnippet,
			relativePath: tdm.getRelativePath(codeSnippet),
		};
	});
}
