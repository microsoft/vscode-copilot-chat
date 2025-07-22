/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { languages, type TextDocument, type Disposable as VscodeDisposable } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';

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
}
