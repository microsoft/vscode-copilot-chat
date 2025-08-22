/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelChat, type ChatRequest } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AutoChatEndpoint } from '../../../platform/endpoint/common/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/common/automodeService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { ChatEndpointFamily, IChatModelInformation, ICompletionModelInformation, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CopilotChatEndpoint } from '../../../platform/endpoint/node/copilotChatEndpoint';
import { IModelMetadataFetcher, ModelMetadataFetcher } from '../../../platform/endpoint/node/modelMetadataFetcher';
import { applyExperimentModifications, ExperimentConfig, getCustomDefaultModelExperimentConfig, ProxyExperimentEndpoint } from '../../../platform/endpoint/node/proxyExperimentEndpoint';
import { ExtensionContributedChatEndpoint } from '../../../platform/endpoint/vscode-node/extChatEndpoint';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';


export class ProductionEndpointProvider implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private readonly _modelFetcher: IModelMetadataFetcher;

	constructor(
		collectFetcherTelemetry: (accessor: ServicesAccessor, error: any) => void,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcher: IFetcherService,
		@IAutomodeService private readonly _autoModeService: IAutomodeService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEnvService _envService: IEnvService,
		@IAuthenticationService _authService: IAuthenticationService,
		@IRequestLogger _requestLogger: IRequestLogger
	) {

		this._modelFetcher = new ModelMetadataFetcher(
			collectFetcherTelemetry,
			false,
			fetcher,
			_requestLogger,
			domainService,
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
		});
	}

	private get _overridenChatModel(): string | undefined {
		return this._configService.getConfig(ConfigKey.Internal.DebugOverrideChatEngine);
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

	private getOrCreateProxyExperimentEndpointInstance(name: string, id: string, endpoint: IChatEndpoint): IChatEndpoint {
		let chatEndpoint = this._chatEndpoints.get(id);
		if (!chatEndpoint) {
			chatEndpoint = new ProxyExperimentEndpoint(name, id, endpoint, /* isDefault: */ true);
			this._chatEndpoints.set(id, chatEndpoint);
		}
		return chatEndpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace(`Resolving chat model`);
		const experimentModelConfig = getCustomDefaultModelExperimentConfig(this._expService);

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
			let modelMetadata = await this._modelFetcher.getChatModelFromFamily(requestOrFamilyOrModel);
			modelMetadata = applyExperimentModifications(modelMetadata, experimentModelConfig);
			endpoint = this.getOrCreateChatEndpointInstance(modelMetadata!);
		} else {
			const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;
			if (experimentModelConfig && model && model.id === experimentModelConfig.id) {
				endpoint = (await this.getAllChatEndpoints()).find(e => e.model === experimentModelConfig.selected) || await this.getChatEndpoint('gpt-4.1');
			} else if (model && model.vendor === 'copilot' && model.id === AutoChatEndpoint.id) {
				return this._autoModeService.resolveAutoModeEndpoint(requestOrFamilyOrModel as ChatRequest, Array.from(this._chatEndpoints.values()));
			} else if (model && model.vendor === 'copilot') {
				let modelMetadata = await this._modelFetcher.getChatModelFromApiModel(model);
				if (modelMetadata) {
					modelMetadata = applyExperimentModifications(modelMetadata, experimentModelConfig);
				}
				// If we fail to resolve a model since this is panel we give GPT-4.1. This really should never happen as the picker is powered by the same service.
				endpoint = modelMetadata ? this.getOrCreateChatEndpointInstance(modelMetadata) : await this.getChatEndpoint('gpt-4.1');
			} else if (model) {
				endpoint = this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
			} else {
				// No explicit family passed and no model picker = gpt-4.1 class model
				endpoint = await this.getChatEndpoint('gpt-4.1');
			}
		}

		this._logService.trace(`Resolved chat model`);
		return endpoint;
	}

	async getAllCompletionModels(forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		return this._modelFetcher.getAllCompletionModels(forceRefresh ?? false);
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const models: IChatModelInformation[] = await this._modelFetcher.getAllChatModels();
		const chatEndpoints = [];

		const experimentModelConfig = getCustomDefaultModelExperimentConfig(this._expService);

		for (let model of models) {

			if (model.id === experimentModelConfig?.selected) {
				/* __GDPR__
					"custommodel.found" : {
						"owner": "karthiknadig",
						"comment": "Reports that an experimental model was in the list of models.",
						"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Model in found list." }
					}
				*/
				this._telemetryService.sendTelemetryEvent('custommodel.found', { microsoft: true, github: false }, {
					model: model.id,
				});
				// The above telemetry is needed for easier filtering.
			}

			model = this.applyModifications(model, experimentModelConfig);
			const chatEndpoint = this.getOrCreateChatEndpointInstance(model);
			chatEndpoints.push(chatEndpoint);
			if (experimentModelConfig && chatEndpoint.model === experimentModelConfig.selected) {
				chatEndpoints.push(this.getOrCreateProxyExperimentEndpointInstance(experimentModelConfig.name, experimentModelConfig.id, chatEndpoint));
			}
		}

		return chatEndpoints;
	}

	private applyModifications(modelMetadata: IChatModelInformation, experimentModelConfig: ExperimentConfig | undefined): IChatModelInformation {
		modelMetadata = applyExperimentModifications(modelMetadata, experimentModelConfig);

		return modelMetadata;
	}
}
