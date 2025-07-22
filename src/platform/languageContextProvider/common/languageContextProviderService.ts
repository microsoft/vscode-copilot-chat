/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Disposable, TextDocument } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { createServiceIdentifier } from '../../../util/common/services';

export const ILanguageContextProviderService = createServiceIdentifier<ILanguageContextProviderService>('ILanguageContextProviderService');

export interface ILanguageContextProviderService {
	readonly _serviceBrand: undefined;

	registerContextProvider<T extends Copilot.SupportedContextItem>(provider: Copilot.ContextProvider<T>): Disposable;

	getContextProviders(doc: TextDocument): Copilot.ContextProvider<Copilot.SupportedContextItem>[];
}
