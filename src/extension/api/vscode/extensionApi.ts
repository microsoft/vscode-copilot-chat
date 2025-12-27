/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextEditor, window } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { IObservabilityService } from '../../../platform/observability/common/observabilityService';
import { IScopeSelector } from '../../../platform/scopeSelection/common/scopeSelection';
import { CopilotExtensionApi as ICopilotExtensionApi } from './api';
import { VSCodeContextProviderApiV1 } from './vscodeContextProviderApi';

export class CopilotExtensionApi implements ICopilotExtensionApi {
	/**
	 * Public API version exposed to external extensions.
	 *
	 * Version 2 adds chat request observability events
	 * ({@link CopilotExtensionApi#onDidStartChatRequest} and
	 * {@link CopilotExtensionApi#onDidFinishChatRequest}) to the public
	 * surface, while keeping the existing v1 context provider API available
	 * via {@link CopilotExtensionApi#getContextProviderAPI}.
	 *
	 */
	public static readonly version = 2;

	constructor(
		@IScopeSelector private readonly _scopeSelector: IScopeSelector,
		@ILanguageContextProviderService private readonly _languageContextProviderService: ILanguageContextProviderService,
		@IObservabilityService private readonly _observabilityService: IObservabilityService,
	) { }

	get onDidStartChatRequest() {
		return this._observabilityService.onDidStartChatRequest;
	}

	get onDidFinishChatRequest() {
		return this._observabilityService.onDidFinishChatRequest;
	}

	async selectScope(editor?: TextEditor, options?: { reason?: string }) {
		editor ??= window.activeTextEditor;
		if (!editor) {
			return;
		}
		return this._scopeSelector.selectEnclosingScope(editor, options);
	}

	getContextProviderAPI(_version: 'v1'): Copilot.ContextProviderApiV1 {
		return new VSCodeContextProviderApiV1(this._languageContextProviderService);
	}
}
