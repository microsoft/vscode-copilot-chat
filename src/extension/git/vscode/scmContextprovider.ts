/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService, ProviderTarget } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';

export class ScmContextProviderContribution extends Disposable {

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ILanguageContextProviderService private readonly _languageContextProviderService: ILanguageContextProviderService
	) {
		super();

		this._register(this.registerContextProvider());
	}

	private registerContextProvider(): IDisposable {
		const disposables = new DisposableStore();

		try {
			const provider: Copilot.ContextProvider<Copilot.SupportedContextItem> = {
				id: 'scm-context-provider',
				selector: { scheme: 'vscode-scm' }, // TODO: Verify if this is the correct document selector for SCM
				resolver: new ScmContextResolver()
			};
			disposables.add(this._languageContextProviderService.registerContextProvider(provider, [ProviderTarget.Completions]));
		} catch (error) {
			this._logService.error('Error registering SCM context provider:', error);
		}

		return disposables;
	}
}

class ScmContextResolver implements Copilot.ContextResolver<Copilot.SupportedContextItem> {

	constructor() { }

	async resolve(request: Copilot.ResolveRequest, token: CancellationToken): Promise<Copilot.SupportedContextItem[]> {
		return [{
			// Provide some informational context. Will be included in the prompt with the format "name: value". Check promptFileContextService.ts for nice examples.
			name: '...',
			value: '...',
			importance: 100 // High importance
		}, {
			// File snippets should use this CodeSnippet format so the ignore service can exclude the contents if needed
			uri: '...',
			name: '...',
			value: 'const example = "This is an example content from a file in SCM."',
			importance: 50 // Medium importance.
		}];
	}

	resolveOnTimeout(request: Copilot.ResolveRequest): Copilot.SupportedContextItem[] {
		return []; // Is called after a timeout for a last chance to provide context
	}
}