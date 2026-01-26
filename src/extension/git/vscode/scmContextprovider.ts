/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService, ProviderTarget } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';

export class ScmContextProviderContribution extends Disposable {

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ILanguageContextProviderService private readonly _languageContextProviderService: ILanguageContextProviderService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
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
				resolver: new ScmContextResolver(this._configurationService)
			};
			disposables.add(this._languageContextProviderService.registerContextProvider(provider, [ProviderTarget.Completions]));
		} catch (error) {
			this._logService.error('Error registering SCM context provider:', error);
		}

		return disposables;
	}
}

class ScmContextResolver implements Copilot.ContextResolver<Copilot.SupportedContextItem> {

	constructor(
		private readonly _configurationService: IConfigurationService
	) { }

	async resolve(request: Copilot.ResolveRequest, token: CancellationToken): Promise<Copilot.SupportedContextItem[]> {
		const contextItems: Copilot.SupportedContextItem[] = [];

		// Get git configuration values that affect commit message formatting
		const inputValidationLength = this._configurationService.getNonExtensionConfig<number>('git.inputValidationLength') ?? 72;
		const inputValidationSubjectLength = this._configurationService.getNonExtensionConfig<number>('git.inputValidationSubjectLength') ?? 50;

		// Build commit message guidelines based on configuration
		const guidelines: string[] = [
			'This is a git commit message input field.',
			'Only provide a completion if you are confident you understand the intent of the user\'s commit based on the staged changes.',
			'Write in natural human language, not code or technical syntax.',
			'Use imperative mood (e.g., "Add feature" not "Added feature").',
			`Keep the first line (subject) under ${inputValidationSubjectLength} characters.`,
			`Keep all lines under ${inputValidationLength} characters.`,
			'If the user continues to a second line, add a more detailed description of the change.',
			'If the changes are unclear or ambiguous, do not provide a completion.'
		];

		contextItems.push({
			name: 'Commit message guidelines',
			value: guidelines.join(' '),
			importance: 100
		});

		return contextItems;
	}
}