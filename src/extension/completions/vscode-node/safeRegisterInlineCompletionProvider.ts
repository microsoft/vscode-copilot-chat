/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DocumentSelector, InlineCompletionItemProvider, InlineCompletionItemProviderMetadata, languages } from 'vscode';

/**
 * Registers an inline completion provider, falling back to the stable 2-arg API
 * if the `inlineCompletionsAdditions` proposed API is not available.
 *
 * When the proposal is unavailable the metadata parameter (groupId, excludes,
 * debounceDelayMs, displayName, yieldTo) is silently dropped.
 */
export function registerInlineCompletionItemProviderSafe(
	selector: DocumentSelector,
	provider: InlineCompletionItemProvider,
	metadata?: InlineCompletionItemProviderMetadata
): Disposable {
	if (metadata && 'onDidChangeCompletionsUnificationState' in languages) {
		return languages.registerInlineCompletionItemProvider(selector, provider, metadata);
	}
	return languages.registerInlineCompletionItemProvider(selector, provider);
}
