/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotClient } from '@github/copilot-sdk';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { CopilotCLIModelInfo, ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';

export class CopilotCLIModels extends Disposable implements ICopilotCLIModels {
	declare _serviceBrand: undefined;
	private readonly _availableModels: Lazy<Promise<CopilotCLIModelInfo[]>>;
	private readonly _onDidChange = this._register(new Emitter<void>());
	constructor(
		private readonly _getOrCreateClient: () => Promise<CopilotClient>,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
	) {
		super();
		this._availableModels = new Lazy<Promise<CopilotCLIModelInfo[]>>(() => this._getAvailableModels());
		// Eagerly fetch available models so that they're ready when needed.
		this._availableModels.value
			.then(() => this._onDidChange.fire())
			.catch(error => {
				this.logService.error('[CopilotCLIModels] Failed to fetch available models', error);
			});
		this._register(this._authenticationService.onDidAuthenticationChange(() => {
			// Auth changed which means models could've changed. Fire the event
			this._onDidChange.fire();
		}));
	}

	async resolveModel(modelId: string): Promise<string | undefined> {
		const models = await this.getModels();
		modelId = modelId.trim().toLowerCase();
		return models.find(m => m.id.toLowerCase() === modelId || m.name.toLowerCase() === modelId)?.id;
	}

	public async getDefaultModel(): Promise<string | undefined> {
		// First item in the list is always the default model (SDK sends the list ordered based on default preference)
		const models = await this.getModels();
		if (!models.length) {
			return;
		}
		const defaultModel = models[0];
		const preferredModelId = this.extensionContext.globalState.get<string>(COPILOT_CLI_MODEL_MEMENTO_KEY, defaultModel.id)?.trim()?.toLowerCase();

		return models.find(m => m.id.toLowerCase() === preferredModelId)?.id ?? defaultModel.id;
	}

	public async setDefaultModel(modelId: string | undefined): Promise<void> {
		await this.extensionContext.globalState.update(COPILOT_CLI_MODEL_MEMENTO_KEY, modelId);
	}

	public async getModels(): Promise<CopilotCLIModelInfo[]> {
		if (!this._authenticationService.anyGitHubSession) {
			return [];
		}

		// No need to query sdk multiple times, cache the result, this cannot change during a vscode session.
		return this._availableModels.value;
	}

	private async _getAvailableModels(): Promise<CopilotCLIModelInfo[]> {
		try {
			const client = await this._getOrCreateClient();
			const models = await client.listModels();
			return models.map(model => ({
				id: model.id,
				name: model.name,
				multiplier: model.billing?.multiplier,
				maxInputTokens: model.capabilities.limits.max_prompt_tokens,
				maxOutputTokens: undefined,
				maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
				supportsVision: model.capabilities.supports.vision,
			} satisfies CopilotCLIModelInfo));
		} catch (ex) {
			this.logService.error('[CopilotCLIModels] Failed to fetch models', ex);
			return [];
		}
	}

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: async (_options, _token) => {
				return this._provideLanguageModelChatInfo();
			},
			provideLanguageModelChatResponse: async (_model, _messages, _options, _progress, _token) => {
				// Implemented via chat participants.
			},
			provideTokenCount: async (_model, _text, _token) => {
				// Token counting is not currently supported for the copilotcli provider.
				return 0;
			}
		};
		this._register(lm.registerLanguageModelChatProvider('copilotcli', provider));

		void this._availableModels.value.then(() => this._onDidChange.fire());
	}

	private async _provideLanguageModelChatInfo(): Promise<vscode.LanguageModelChatInformation[]> {
		const models = await this.getModels();
		return models.map((model, index) => {
			const multiplier = model.multiplier === undefined ? undefined : `${model.multiplier}x`;
			return {
				id: model.id,
				name: model.name,
				family: model.id,
				version: '',
				maxInputTokens: model.maxInputTokens ?? model.maxContextWindowTokens,
				maxOutputTokens: model.maxOutputTokens ?? 0,
				multiplier,
				multiplierNumeric: model.multiplier,
				isUserSelectable: true,
				capabilities: {
					imageInput: model.supportsVision
				},
				targetChatSessionType: 'copilotcli',
				isDefault: index === 0 // SDK guarantees the first item is the default model
			};
		});
	}
}
