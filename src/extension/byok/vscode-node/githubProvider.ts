/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { authentication } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class GitHubProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'GitHub';
	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.None,
			GitHubProvider.providerName,
			'https://models.github.ai/inference',
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch('https://models.github.ai/catalog/models', { method: 'GET' });
			const models: any = await response.json();
			const knownModels: BYOKKnownModels = {};
			for (const model of models) {
				knownModels[model.id] = {
					name: model.name,
					toolCalling: model.capabilities?.includes('tool-calling') ?? false,
					vision: model.supported_input_modalities?.includes('image') ?? false,
					maxInputTokens: model.limits?.max_input_tokens ?? 4096,
					maxOutputTokens: model.limits?.max_output_tokens ?? 4096
				};
			}
			this._knownModels = knownModels;
			return knownModels;
		} catch (error) {
			this._logService.error('Error fetching available GitHub models:', error);
			throw error;
		}
	}
	/**
	 * Gets the GitHub access token using VS Code's authentication API
	 * @returns Promise<string | undefined> GitHub access token if available
	 */
	async getGitHubToken(): Promise<string | undefined> {
		const session = await authentication.getSession(
			'github',
			['repo', 'user:email'],
			{ createIfNone: true }
		);
		return session?.accessToken;
	}
}