/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

const selector: vscode.DocumentSelector = [
	{ scheme: 'file', language: 'typescript' },
	{ scheme: 'file', language: 'typescriptreact' },
	{ scheme: 'file', language: 'javascript' },
	{ scheme: 'file', language: 'javascriptreact' },
	{ scheme: 'untitled', language: 'typescript' },
	{ scheme: 'untitled', language: 'typescriptreact' },
	{ scheme: 'untitled', language: 'javascript' },
	{ scheme: 'untitled', language: 'javascriptreact' }
];

export class CopilotTypeHierarchyProviderAdapter implements vscode.TypeHierarchyProvider {
	constructor(
		private readonly languageFeaturesService: ILanguageFeaturesService
	) { }

	async prepareTypeHierarchy(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const items = await this.languageFeaturesService.prepareTypeHierarchy(document.uri, position);
		if (token.isCancellationRequested) {
			return undefined;
		}

		return items.length > 0 ? items : undefined;
	}

	async provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const supertypes = await this.languageFeaturesService.getTypeHierarchySupertypes(item);
		return token.isCancellationRequested ? undefined : supertypes;
	}

	async provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const subtypes = await this.languageFeaturesService.getTypeHierarchySubtypes(item);
		return token.isCancellationRequested ? undefined : subtypes;
	}
}

export class TypeHierarchyContribution extends Disposable implements IExtensionContribution {
	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService
	) {
		super();

		const provider = new CopilotTypeHierarchyProviderAdapter(this.languageFeaturesService);
		this._register(vscode.languages.registerTypeHierarchyProvider(selector, provider));
	}
}
