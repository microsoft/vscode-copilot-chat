/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelChat, type ChatRequest } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, IChatModelInformation, ICompletionModelInformation, IEmbeddingModelInformation, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { AutoChatEndpoint } from '../../../platform/endpoint/node/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/node/automodeService';
import { CopilotChatEndpoint } from '../../../platform/endpoint/node/copilotChatEndpoint';
import { EmbeddingEndpoint } from '../../../platform/endpoint/node/embeddingsEndpoint';
import { IModelMetadataFetcher, ModelMetadataFetcher } from '../../../platform/endpoint/node/modelMetadataFetcher';
import { ExtensionContributedChatEndpoint } from '../../../platform/endpoint/vscode-node/extChatEndpoint';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../../platform/networking/common/networking';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TokenizerType } from '../../../util/common/tokenizer';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';


export class ProductionEndpointProvider implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidModelsRefresh = new Emitter<void>();
	readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private _embeddingEndpoints: Map<string, IEmbeddingsEndpoint> = new Map();
	private readonly _modelFetcher: IModelMetadataFetcher;

	constructor(
		collectFetcherTelemetry: (accessor: ServicesAccessor, error: any) => void,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcher: IFetcherService,
		@IAutomodeService private readonly _autoModeService: IAutomodeService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService protected readonly _logService: ILogService,
		@IConfigurationService protected readonly _configService: IConfigurationService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IEnvService _envService: IEnvService,
		@IAuthenticationService protected readonly _authService: IAuthenticationService,
		@IRequestLogger _requestLogger: IRequestLogger
	) {

		this._modelFetcher = new ModelMetadataFetcher(
			collectFetcherTelemetry,
			false,
			fetcher,
			_requestLogger,
			capiClientService,
			this._configService,
			this._expService,
			_envService,
			_authService,
			this._telemetryService,
			_logService,
			_instantiationService,
		);

		// When new models come in from CAPI we want to clear our local caches and let the endpoints be recreated since there may be new info
		this._modelFetcher.onDidModelsRefresh(() => {
			this._chatEndpoints.clear();
			this._embeddingEndpoints.clear();
			this._onDidModelsRefresh.fire();
		});
	}

	private get _overridenChatModel(): string | undefined {
		return this._configService.getConfig(ConfigKey.Advanced.DebugOverrideChatEngine);
	}

	private getOrCreateChatEndpointInstance(modelMetadata: IChatModelInformation): IChatEndpoint {
		const modelId = modelMetadata.id;
		let chatEndpoint = this._chatEndpoints.get(modelId);
		if (!chatEndpoint) {
			chatEndpoint = this._instantiationService.createInstance(CopilotChatEndpoint, modelMetadata);
			this._chatEndpoints.set(modelId, chatEndpoint);
		}
		return chatEndpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace(`Resolving chat model`);

		if (this._overridenChatModel) {
			// Override, only allowed by internal users. Sets model based on setting
			this._logService.trace(`Using overriden chat model`);
			return this.getOrCreateChatEndpointInstance({
				id: this._overridenChatModel,
				name: 'Custom Overriden Chat Model',
				version: '1.0.0',
				model_picker_enabled: true,
				is_chat_default: false,
				is_chat_fallback: false,
				capabilities: {
					supports: { streaming: true },
					tokenizer: TokenizerType.O200K,
					family: 'custom',
					type: 'chat'
				}
			});
		}
		let endpoint: IChatEndpoint;
		if (typeof requestOrFamilyOrModel === 'string') {
			// The family case, resolve the chat model for the passed in family
			const modelMetadata = await this._modelFetcher.getChatModelFromFamily(requestOrFamilyOrModel);
			endpoint = this.getOrCreateChatEndpointInstance(modelMetadata!);
		} else {
			const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;
			if (model && model.vendor === 'copilot' && model.id === AutoChatEndpoint.pseudoModelId) {
				try {
					const allEndpoints = await this.getAllChatEndpoints();
					return this._autoModeService.resolveAutoModeEndpoint(requestOrFamilyOrModel as ChatRequest, allEndpoints);
				} catch {
					return this.getChatEndpoint('copilot-base');
				}
			} else if (model && model.vendor === 'copilot') {
				const modelMetadata = await this._modelFetcher.getChatModelFromApiModel(model);
				// If we fail to resolve a model since this is panel we give copilot base. This really should never happen as the picker is powered by the same service.
				endpoint = modelMetadata ? this.getOrCreateChatEndpointInstance(modelMetadata) : await this.getChatEndpoint('copilot-base');
			} else if (model) {
				endpoint = this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
			} else {
				// No explicit family passed and no model picker = copilot base
				endpoint = await this.getChatEndpoint('copilot-base');
			}
		}

		this._logService.trace(`Resolved chat model`);
		return endpoint;
	}

	async getEmbeddingsEndpoint(family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		this._logService.trace(`Resolving embedding model`);
		const modelMetadata = await this._modelFetcher.getEmbeddingsModel('text-embedding-3-small');
		const model = await this.getOrCreateEmbeddingEndpointInstance(modelMetadata);
		this._logService.trace(`Resolved embedding model`);
		return model;
	}

	private async getOrCreateEmbeddingEndpointInstance(modelMetadata: IEmbeddingModelInformation): Promise<IEmbeddingsEndpoint> {
		const modelId = 'text-embedding-3-small';
		let embeddingEndpoint = this._embeddingEndpoints.get(modelId);
		if (!embeddingEndpoint) {
			embeddingEndpoint = this._instantiationService.createInstance(EmbeddingEndpoint, modelMetadata);
			this._embeddingEndpoints.set(modelId, embeddingEndpoint);
		}
		return embeddingEndpoint;
	}

	async getAllCompletionModels(forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		return this._modelFetcher.getAllCompletionModels(forceRefresh ?? false);
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const models: IChatModelInformation[] = await this._modelFetcher.getAllChatModels();
		return models.map(model => this.getOrCreateChatEndpointInstance(model));
	}
}
