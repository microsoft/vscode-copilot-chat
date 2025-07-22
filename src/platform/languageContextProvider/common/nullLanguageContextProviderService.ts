/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument, Disposable as VscodeDisposable } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILanguageContextProviderService } from './languageContextProviderService';


export class NullLanguageContextProviderService implements ILanguageContextProviderService {
	_serviceBrand: undefined;

	registerContextProvider<T extends Copilot.SupportedContextItem>(provider: Copilot.ContextProvider<T>): VscodeDisposable {
		return Disposable.None;
	}

	getContextProviders(doc: TextDocument): Copilot.ContextProvider<Copilot.SupportedContextItem>[] {
		return [];
	}
}
