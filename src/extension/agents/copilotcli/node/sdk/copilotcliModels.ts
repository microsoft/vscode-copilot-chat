/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../../platform/log/common/logService';
import { Lazy } from '../../../../../util/vs/base/common/lazy';
import { COPILOT_CLI_MODEL_MEMENTO_KEY, CopilotCLIModelInfo, ICopilotCLIModels } from '../copilotCli';
import { ICopilotClientManager } from './copilotClientManager';

/**
 * Implementation of ICopilotCLIModels that fetches models from the new @github/copilot-sdk
 * via CopilotClient.listModels() instead of the old SDK's getAvailableModels().
 */
export class NewSdkCopilotCLIModels implements ICopilotCLIModels {
	declare _serviceBrand: undefined;
	private readonly _availableModels: Lazy<Promise<CopilotCLIModelInfo[]>>;

	constructor(
		@ICopilotClientManager private readonly copilotClientManager: ICopilotClientManager,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		this._availableModels = new Lazy<Promise<CopilotCLIModelInfo[]>>(() => this._getAvailableModels());
		// Eagerly fetch available models so that they're ready when needed.
		this._availableModels.value.catch(error => {
			this.logService.error('[NewSdkCopilotCLIModels] Failed to fetch available models', error);
		});
	}

	async resolveModel(modelId: string): Promise<string | undefined> {
		const models = await this.getModels();
		modelId = modelId.trim().toLowerCase();
		return models.find(m => m.id.toLowerCase() === modelId || m.name.toLowerCase() === modelId)?.id;
	}

	public async getDefaultModel(): Promise<string | undefined> {
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
		return this._availableModels.value;
	}

	private async _getAvailableModels(): Promise<CopilotCLIModelInfo[]> {
		try {
			const client = await this.copilotClientManager.getClient();
			const models = await client.listModels();
			return models.map(model => ({
				id: model.id,
				name: model.name,
				multiplier: model.billing?.multiplier,
			}));
		} catch (ex) {
			this.logService.error(ex, '[NewSdkCopilotCLIModels] Failed to fetch models');
			return [];
		}
	}
}
