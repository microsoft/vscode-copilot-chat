/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { NoopLanguageFeaturesService } from '../../../../platform/languages/common/languageFeaturesService';
import { CopilotTypeHierarchyProviderAdapter } from '../typeHierarchy.contribution';

class TestLanguageFeaturesService extends NoopLanguageFeaturesService {
	prepareItems: vscode.TypeHierarchyItem[] = [];
	supertypesItems: vscode.TypeHierarchyItem[] = [];
	subtypesItems: vscode.TypeHierarchyItem[] = [];
	onBeforePrepareResolve: (() => void) | undefined;
	readonly prepareSpy = vi.fn();
	readonly supertypesSpy = vi.fn();
	readonly subtypesSpy = vi.fn();

	override async prepareTypeHierarchy(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
		this.prepareSpy(uri, position);
		this.onBeforePrepareResolve?.();
		return this.prepareItems;
	}

	override async getTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
		this.supertypesSpy(item);
		return this.supertypesItems;
	}

	override async getTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
		this.subtypesSpy(item);
		return this.subtypesItems;
	}
}

const noopDisposable: vscode.Disposable = { dispose() { /* noop */ } };

function createToken(initial = false): { token: vscode.CancellationToken; cancel(): void } {
	let cancelled = initial;
	const event: vscode.Event<unknown> = () => noopDisposable;
	return {
		token: {
			get isCancellationRequested() {
				return cancelled;
			},
			onCancellationRequested: event
		},
		cancel() {
			cancelled = true;
		}
	};
}

describe('CopilotTypeHierarchyProviderAdapter', () => {
	const uri = { path: '/tmp/sample.ts' } as vscode.Uri;
	const position = { line: 1, character: 4 } as vscode.Position;
	const document = { uri } as vscode.TextDocument;

	it('returns undefined when cancelled before prepare', async () => {
		const languageFeatures = new TestLanguageFeaturesService();
		languageFeatures.prepareItems = [{} as vscode.TypeHierarchyItem];
		const adapter = new CopilotTypeHierarchyProviderAdapter(languageFeatures);
		const { token } = createToken(true);

		const result = await adapter.prepareTypeHierarchy(document, position, token);

		expect(languageFeatures.prepareSpy).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it('delegates to language features service for hierarchy results', async () => {
		const languageFeatures = new TestLanguageFeaturesService();
		const expectedItems = [{} as vscode.TypeHierarchyItem];
		languageFeatures.prepareItems = expectedItems;
		const adapter = new CopilotTypeHierarchyProviderAdapter(languageFeatures);
		const { token } = createToken();

		const result = await adapter.prepareTypeHierarchy(document, position, token);

		expect(languageFeatures.prepareSpy).toHaveBeenCalledWith(uri, position);
		expect(result).toBe(expectedItems);
	});

	it('returns undefined when cancellation is requested after resolve', async () => {
		const { token, cancel } = createToken();
		const languageFeatures = new TestLanguageFeaturesService();
		languageFeatures.prepareItems = [{} as vscode.TypeHierarchyItem];
		languageFeatures.onBeforePrepareResolve = () => cancel();
		const adapter = new CopilotTypeHierarchyProviderAdapter(languageFeatures);

		const result = await adapter.prepareTypeHierarchy(document, position, token);

		expect(result).toBeUndefined();
	});

	it('delegates to service for super and sub types', async () => {
		const languageFeatures = new TestLanguageFeaturesService();
		const supertypes = [{} as vscode.TypeHierarchyItem];
		const subtypes = [{} as vscode.TypeHierarchyItem];
		languageFeatures.supertypesItems = supertypes;
		languageFeatures.subtypesItems = subtypes;
		const adapter = new CopilotTypeHierarchyProviderAdapter(languageFeatures);
		const { token } = createToken();
		const item = {} as vscode.TypeHierarchyItem;

		const superResult = await adapter.provideTypeHierarchySupertypes(item, token);
		const subResult = await adapter.provideTypeHierarchySubtypes(item, token);

		expect(languageFeatures.supertypesSpy).toHaveBeenCalledWith(item);
		expect(superResult).toBe(supertypes);
		expect(languageFeatures.subtypesSpy).toHaveBeenCalledWith(item);
		expect(subResult).toBe(subtypes);
	});
});
