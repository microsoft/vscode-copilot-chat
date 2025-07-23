/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type CancellationToken, languages, type TextDocument, type Disposable as VscodeDisposable } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ContextItem, ContextKind, SnippetContext, TraitContext } from '../../../platform/languageServer/common/languageContextService';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';

export class LanguageContextProviderService extends Disposable implements ILanguageContextProviderService {
	_serviceBrand: undefined;

	private providers: Copilot.ContextProvider<Copilot.SupportedContextItem>[] = [];

	public registerContextProvider<T extends Copilot.SupportedContextItem>(provider: Copilot.ContextProvider<T>): VscodeDisposable {
		this.providers.push(provider);
		return toDisposable(() => {
			const index = this.providers.indexOf(provider);
			if (index > -1) {
				this.providers.splice(index, 1);
			}
		});
	}

	public getContextProviders(doc: TextDocument): Copilot.ContextProvider<Copilot.SupportedContextItem>[] {
		return this.providers.filter(provider => languages.match(provider.selector, doc));
	}

	public override dispose(): void {
		super.dispose();
		this.providers.length = 0;
	}

	public getContextItems(doc: TextDocument, request: Copilot.ResolveRequest, cancellationToken: CancellationToken): AsyncIterable<ContextItem> {
		const providers = this.getContextProviders(doc);

		const items = new AsyncIterableObject<{ context: Copilot.SupportedContextItem; timeStamp: number; onTimeout: boolean }>(async emitter => {
			async function runProvider(provider: Copilot.ContextProvider<Copilot.SupportedContextItem>) {
				const langCtx = provider.resolver.resolve(request, cancellationToken);
				if (typeof (langCtx as any)[Symbol.asyncIterator] === 'function') {
					for await (const context of langCtx as AsyncIterable<Copilot.SupportedContextItem>) {
						emitter.emitOne({ context, timeStamp: Date.now(), onTimeout: false });
					}
					return;
				}
				const result = await langCtx;
				if (Array.isArray(result)) {
					for (const context of result) {
						emitter.emitOne({ context, timeStamp: Date.now(), onTimeout: false });
					}
				} else if (typeof (result as any)[Symbol.asyncIterator] !== 'function') {
					// Only push if it's a single SupportedContextItem, not an AsyncIterable
					emitter.emitOne({ context: result as Copilot.SupportedContextItem, timeStamp: Date.now(), onTimeout: false });
				}
			}

			await Promise.allSettled(providers.map(runProvider));
		});

		const contextItems = items.map(item => {
			const isSnippet = item && typeof item === 'object' && (item as any).uri !== undefined;
			if (isSnippet) {
				const ctx = item.context as Copilot.CodeSnippet;
				return {
					kind: ContextKind.Snippet,
					priority: ctx.importance ? ctx.importance : 0,
					uri: URI.parse(ctx.uri),
					value: ctx.value
				} satisfies SnippetContext;
			} else {
				const ctx = item.context as Copilot.Trait;
				return {
					kind: ContextKind.Trait,
					priority: ctx.importance ? ctx.importance : 0,
					name: ctx.name,
					value: ctx.value,
				} satisfies TraitContext;
			}
		});

		return contextItems;
	}

	public getContextItemsOnTimeout(doc: TextDocument, request: Copilot.ResolveRequest): ContextItem[] {
		return [];
	}

}
