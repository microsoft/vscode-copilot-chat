/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { languages } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, observableFromEvent } from '../../../util/vs/base/common/observableInternal';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { createContext, setup } from '../../completions-core/vscode-node/completionsServiceBridges';
import { CopilotInlineCompletionItemProvider } from '../../completions-core/vscode-node/extension/src/inlineCompletion';
import { unificationStateObservable } from './completionsUnificationContribution';

export class CompletionsCoreContribution extends Disposable {

	private _provider: CopilotInlineCompletionItemProvider | undefined;

	private readonly _copilotToken = observableFromEvent(this, this.authenticationService.onDidAuthenticationChange, () => this.authenticationService.copilotToken);

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super();

		const unificationState = unificationStateObservable(this);

		this._register(autorun(reader => {
			const unificationStateValue = unificationState.read(reader);
			const configEnabled = configurationService.getExperimentBasedConfigObservable<boolean>(ConfigKey.Internal.InlineEditsEnableGhCompletionsProvider, experimentationService).read(reader);

			if (unificationStateValue?.codeUnification || configEnabled || this._copilotToken.read(reader)?.isNoAuthUser) {
				const provider = this._getOrCreateProvider();
				reader.store.add(languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider, { debounceDelayMs: 0, excludes: ['github.copilot'], groupId: 'completions' }));
			}
		}));
	}

	private _getOrCreateProvider() {
		if (!this._provider) {
			const ctx = this._instantiationService.invokeFunction(createContext);
			this._register(setup(ctx));
			this._provider = this._register(new CopilotInlineCompletionItemProvider(ctx));
		}
		return this._provider;
	}
}
