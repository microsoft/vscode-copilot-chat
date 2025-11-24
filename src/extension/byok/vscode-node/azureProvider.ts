/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { AzureAuthMode, ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isEndpointEditToolName } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels } from '../common/byokProvider';
import { AzureOpenAIEndpoint } from '../node/azureOpenAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider, CustomOAIModelInfo, hasExplicitApiPath } from './customOAIProvider';

export function resolveAzureUrl(modelId: string, url: string): string {
	// The fully resolved url was already passed in
	if (hasExplicitApiPath(url)) {
		return url;
	}

	// Remove the trailing slash
	if (url.endsWith('/')) {
		url = url.slice(0, -1);
	}
	// if url ends with `/v1` remove it
	if (url.endsWith('/v1')) {
		url = url.slice(0, -3);
	}

	// Default to chat completions for base URLs
	const defaultApiPath = '/chat/completions';

	if (url.includes('models.ai.azure.com') || url.includes('inference.ml.azure.com')) {
		return `${url}/v1${defaultApiPath}`;
	} else if (url.includes('openai.azure.com')) {
		return `${url}/openai/deployments/${modelId}${defaultApiPath}?api-version=2025-01-01-preview`;
	} else {
		throw new Error(`Unrecognized Azure deployment URL: ${url}`);
	}
}

export class AzureBYOKModelProvider extends CustomOAIBYOKModelProvider {
	static override readonly providerName = 'Azure';

	constructor(
		byokStorageService: IBYOKStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService experimentationService: IExperimentationService
	) {
		super(
			byokStorageService,
			configurationService,
			logService,
			instantiationService,
			experimentationService
		);
		// Override the instance properties
		this.providerName = AzureBYOKModelProvider.providerName;
	}

	protected override getConfigKey() {
		return ConfigKey.AzureModels;
	}

	protected override resolveUrl(modelId: string, url: string): string {
		return resolveAzureUrl(modelId, url);
	}

	protected override async getModelsWithCredentials(silent: boolean): Promise<BYOKKnownModels> {
		// Check user's authentication preference from settings github.copilot.chat.azureAuthType (default: AzureAuthMode.EntraId)
		const authType = this._configurationService.getConfig(ConfigKey.AzureAuthType);

		if (authType === AzureAuthMode.EntraId) {
			// Pre-authenticate during model enumeration (not when sending message)
			// This mirrors API key behavior where user is prompted during enumeration
			if (!silent) {
				try {
					await vscode.authentication.getSession(
						AzureAuthMode.MICROSOFT_AUTH_PROVIDER,
						[AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
						{ createIfNone: true }
					);
				} catch (error) {
					// If sign-in fails, don't show models in picker
					this._logService.error('[AzureBYOKModelProvider] Authentication failed during Entra ID sign-in:', error);
					return {};
				}
			}

			// Return all configured models (no API key check needed for Entra ID)
			return this.getAllModels();
		} else {
			// API KEY MODE: Use traditional API key authentication
			return super.getModelsWithCredentials(silent);
		}
	}

	override async provideLanguageModelChatResponse(
		model: CustomOAIModelInfo,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const authType = this._configurationService.getConfig(ConfigKey.AzureAuthType);

		if (authType === AzureAuthMode.EntraId) {
			// Session is guaranteed to be defined when createIfNone: true
			const session: vscode.AuthenticationSession = await vscode.authentication.getSession(
				AzureAuthMode.MICROSOFT_AUTH_PROVIDER,
				[AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
				{
					createIfNone: true,
					silent: false
				}
			);

			const modelInfo = await this.getModelInfo(model.id, undefined, {
				maxInputTokens: model.maxInputTokens,
				maxOutputTokens: model.maxOutputTokens,
				toolCalling: !!model.capabilities?.toolCalling,
				vision: !!model.capabilities?.imageInput,
				name: model.name,
				url: model.url,
				thinking: model.thinking,
				editTools: model.capabilities?.editTools?.filter(isEndpointEditToolName),
				requestHeaders: model.requestHeaders,
			});

			const openAIChatEndpoint = this._instantiationService.createInstance(
				AzureOpenAIEndpoint,
				modelInfo,
				session.accessToken,  // Pass Entra ID token
				model.url
			);

			return this._lmWrapper.provideLanguageModelResponse(
				openAIChatEndpoint,
				messages,
				options,
				options.requestInitiator,
				progress,
				token
			);
		} else {
			// API KEY AUTHENTICATION FLOW using parent logic
			return super.provideLanguageModelChatResponse(model, messages, options, progress, token);
		}
	}
}
