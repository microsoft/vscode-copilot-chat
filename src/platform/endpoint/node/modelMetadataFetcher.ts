/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { LanguageModelChat } from 'vscode';
import { createRequestHMAC } from '../../../util/common/crypto';
import { TaskSingler } from '../../../util/common/taskSingler';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { getRequest } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { ChatEndpointFamily, IChatModelInformation, IEmbeddingModelInformation, IModelAPIResponse, isChatModelInformation, isEmbeddingModelInformation } from '../common/endpointProvider';
import { getMaxPromptTokens } from './chatEndpoint';

export interface IModelMetadataFetcher {

	/**
	 * Fires whenever we refresh the models from the server.
	 * Does not always indicate there is a change, just that the data is fresh
	 */
	onDidModelsRefresh: Event<void>;

	/**
	 * Gets all the chat models known by the model fetcher endpoint
	 */
	getAllChatModels(): Promise<IChatModelInformation[]>;

	/**
	 * Retrieves a chat model by its family name
	 * @param family The family of the model to fetch
	 */
	getChatModelFromFamily(family: ChatEndpointFamily): Promise<IChatModelInformation>;

	/**
	 * Retrieves a chat model by its id
	 * @param id The id of the chat model you want to get
	 * @returns The chat model information if found, otherwise undefined
	 */
	getChatModelFromApiModel(model: LanguageModelChat): Promise<IChatModelInformation | undefined>;

	/**
	 * Retrieves an embeddings model by its family name
	 * @param family The family of the model to fetch
	 */
	getEmbeddingsModel(family: 'text-embedding-3-small'): Promise<IEmbeddingModelInformation>;
}

/**
 * Responsible for interacting with the CAPI Model API
 * This is solely owned by the EndpointProvider (and TestEndpointProvider) which uses this service to power server side rollout of models
 * All model acquisition should be done through the EndpointProvider
 */
export class ModelMetadataFetcher implements IModelMetadataFetcher {

	private static readonly ALL_MODEL_KEY = 'allModels';

	private _familyMap: Map<string, IModelAPIResponse[]> = new Map();
	private _copilotBaseModel: IModelAPIResponse | undefined;
	private _lastFetchTime: number = 0;
	private readonly _taskSingler = new TaskSingler<IModelAPIResponse | undefined | void>();
	private _lastFetchError: any;

	private readonly _onDidModelRefresh = new Emitter<void>();
	public onDidModelsRefresh = this._onDidModelRefresh.event;

	constructor(
		private readonly collectFetcherTelemetry: ((accessor: ServicesAccessor) => void) | undefined,
		protected readonly _isModelLab: boolean,
		@IFetcherService private readonly _fetcher: IFetcherService,
		@IDomainService private readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IEnvService private readonly _envService: IEnvService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	public async getAllChatModels(): Promise<IChatModelInformation[]> {
		await this._taskSingler.getOrCreate(ModelMetadataFetcher.ALL_MODEL_KEY, this._fetchModels.bind(this));
		const chatModels: IChatModelInformation[] = [];
		for (const [, models] of this._familyMap) {
			for (let model of models) {
				model = await this._hydrateResolvedModel(model);
				if (isChatModelInformation(model)) {
					chatModels.push(model);
				}
			}
		}
		return chatModels;
	}

	/**
	 * Hydrates a model API response from the `/models` endpoint with proper exp overrides and error handling
	 * @param resolvedModel The resolved model to hydrate
	 * @returns The resolved model with proper exp overrides and token counts
	 */
	private async _hydrateResolvedModel(resolvedModel: IModelAPIResponse | undefined): Promise<IModelAPIResponse> {
		resolvedModel = resolvedModel ? await this._findExpOverride(resolvedModel) : undefined;
		if (!resolvedModel) {
			throw this._lastFetchError;
		}

		// If it's a chat model, update max prompt tokens based on settings + exp
		if (isChatModelInformation(resolvedModel) && (resolvedModel.capabilities.limits)) {
			resolvedModel.capabilities.limits.max_prompt_tokens = getMaxPromptTokens(this._configService, this._expService, resolvedModel);
			// Also ensure prompt tokens + output tokens <= context window. Output tokens is capped to max 15% input tokens
			const outputTokens = Math.floor(Math.min(resolvedModel.capabilities.limits.max_output_tokens ?? 4096, resolvedModel.capabilities.limits.max_prompt_tokens * 0.15));
			const contextWindow = resolvedModel.capabilities.limits.max_context_window_tokens ?? (outputTokens + resolvedModel.capabilities.limits.max_prompt_tokens);
			resolvedModel.capabilities.limits.max_prompt_tokens = Math.min(resolvedModel.capabilities.limits.max_prompt_tokens, contextWindow - outputTokens);
		}
		if (resolvedModel.preview && !resolvedModel.name.endsWith('(Preview)')) {
			// If the model is a preview model, we append (Preview) to the name
			resolvedModel.name = `${resolvedModel.name} (Preview)`;
		}
		return resolvedModel;
	}

	public async getChatModelFromFamily(family: ChatEndpointFamily): Promise<IChatModelInformation> {
		await this._taskSingler.getOrCreate(ModelMetadataFetcher.ALL_MODEL_KEY, this._fetchModels.bind(this));
		let resolvedModel: IModelAPIResponse | undefined;
		if (family === 'gpt-4.1') {
			resolvedModel = this._familyMap.get('gpt-4.1')?.[0] ?? this._familyMap.get('gpt-4o')?.[0];
		} else if (family === 'gpt-4o-mini') {
			resolvedModel = this._familyMap.get('gpt-4o-mini')?.[0];
		} else if (family === 'copilot-base') {
			resolvedModel = this._copilotBaseModel;
		} else {
			resolvedModel = this._familyMap.get(family)?.[0];
		}
		resolvedModel = await this._hydrateResolvedModel(resolvedModel);
		if (!isChatModelInformation(resolvedModel)) {
			throw new Error(`Unable to resolve chat model with family selection: ${family}`);
		}
		return resolvedModel;
	}

	public async getChatModelFromApiModel(apiModel: LanguageModelChat): Promise<IChatModelInformation | undefined> {
		await this._taskSingler.getOrCreate(ModelMetadataFetcher.ALL_MODEL_KEY, this._fetchModels.bind(this));
		let resolvedModel: IModelAPIResponse | undefined;
		for (const models of this._familyMap.values()) {
			resolvedModel = models.find(model =>
				model.id === apiModel.id &&
				model.version === apiModel.version &&
				model.capabilities.family === apiModel.family);
			if (resolvedModel) {
				break;
			}
		}
		if (!resolvedModel) {
			return;
		}
		resolvedModel = await this._hydrateResolvedModel(resolvedModel);
		if (!isChatModelInformation(resolvedModel)) {
			throw new Error(`Unable to resolve chat model: ${apiModel.id},${apiModel.name},${apiModel.version},${apiModel.family}`);
		}
		return resolvedModel;
	}

	public async getEmbeddingsModel(family: 'text-embedding-3-small'): Promise<IEmbeddingModelInformation> {
		await this._taskSingler.getOrCreate(ModelMetadataFetcher.ALL_MODEL_KEY, this._fetchModels.bind(this));
		let resolvedModel = this._familyMap.get(family)?.[0];
		resolvedModel = await this._hydrateResolvedModel(resolvedModel);
		if (!isEmbeddingModelInformation(resolvedModel)) {
			throw new Error(`Unable to resolve embeddings model with family selection: ${family}`);
		}
		return resolvedModel;
	}

	private _shouldRefreshModels(): boolean {
		if (this._familyMap.size === 0) {
			return true;
		}
		const tenMinutes = 10 * 60 * 1000; // 10 minutes in milliseconds
		const now = Date.now();

		if (!this._lastFetchTime) {
			return true; // If there's no last fetch time, we should refresh
		}

		// We only want to fetch models if the current session is active
		if (!this._envService.isActive) {
			return false;
		}

		const timeSinceLastFetch = now - this._lastFetchTime;

		return timeSinceLastFetch > tenMinutes;
	}

	private async _fetchModels(force?: boolean): Promise<void> {
		if (!force && !this._shouldRefreshModels()) {
			return;
		}
		const requestStartTime = Date.now();

		const copilotToken = (await this._authService.getCopilotToken()).token;
		const requestId = generateUuid();

		try {
			const response = await getRequest(
				this._fetcher,
				this._envService,
				this._telemetryService,
				this._domainService,
				this._capiClientService,
				{ type: RequestType.Models, isModelLab: this._isModelLab },
				copilotToken,
				await createRequestHMAC(process.env.HMAC_SECRET),
				'model-access',
				requestId,
			);

			this._lastFetchTime = Date.now();
			this._logService.info(`Fetched model metadata in ${Date.now() - requestStartTime}ms ${requestId}`);

			if (response.status < 200 || response.status >= 300) {
				// If we're rate limited and have models, we should just return
				if (response.status === 429 && this._familyMap.size > 0) {
					this._logService.warn(`Rate limited while fetching models ${requestId}`);
					return;
				}
				throw new Error(`Failed to fetch models (${requestId}): ${(await response.text()) || response.statusText || `HTTP ${response.status}`}`);
			}

			this._familyMap.clear();

			const data: IModelAPIResponse[] = (await response.json()).data;
			for (const model of data) {
				// Skip completion models. We don't handle them so we only want chat + embeddings
				if (model.capabilities.type === 'completions') {
					continue;
				}
				// The base model is whatever model is deemed "fallback" by the server
				if (model.is_chat_fallback) {
					this._copilotBaseModel = model;
				}
				const family = model.capabilities.family;
				if (!this._familyMap.has(family)) {
					this._familyMap.set(family, []);
				}
				this._familyMap.get(family)?.push(model);
			}
			this._lastFetchError = undefined;
			this._onDidModelRefresh.fire();

			if (this.collectFetcherTelemetry) {
				this._instantiationService.invokeFunction(this.collectFetcherTelemetry);
			}
		} catch (e) {
			this._logService.error(e, `Failed to fetch models (${requestId})`);
			this._lastFetchError = e;
			this._lastFetchTime = 0;
			// If we fail to fetch models, we should try again next time
		}
	}

	private async _fetchModel(modelId: string): Promise<IModelAPIResponse | undefined> {
		const copilotToken = (await this._authService.getCopilotToken()).token;

		try {
			const response = await getRequest(
				this._fetcher,
				this._envService,
				this._telemetryService,
				this._domainService,
				this._capiClientService,
				{ type: RequestType.ListModel, modelId: modelId },
				copilotToken,
				await createRequestHMAC(process.env.HMAC_SECRET),
				'model-access',
				generateUuid(),
			);

			const data: IModelAPIResponse = await response.json();
			if (data.capabilities.type === 'completions') {
				return;
			}
			// Functions that call this method, check the family map first so this shouldn't result in duplicate entries
			if (this._familyMap.has(data.capabilities.family)) {
				this._familyMap.get(data.capabilities.family)?.push(data);
			} else {
				this._familyMap.set(data.capabilities.family, [data]);
			}
			this._onDidModelRefresh.fire();
			return data;
		} catch {
			// Couldn't find this model, must not be availabe in CAPI.
			return undefined;
		}
	}

	private async _findExpOverride(resolvedModel: IModelAPIResponse): Promise<IModelAPIResponse | undefined> {
		// This is a mapping of model id to model id. Allowing us to override the request for any model with a different model
		let modelExpOverrides: { [key: string]: string } = {};
		const expResult = this._expService.getTreatmentVariable<string>('vscode', 'copilotchat.modelOverrides');
		try {
			modelExpOverrides = JSON.parse(expResult || '{}');
		} catch {
			// No-op if parsing experiment fails
		}
		if (modelExpOverrides[resolvedModel.id]) {
			for (const [, models] of this._familyMap) {
				const model = models.find(m => m.id === modelExpOverrides[resolvedModel.id]);
				// Found the model in the cache, return it
				if (model) {
					return model;
				}
			}
			const experimentalModel = await this._taskSingler.getOrCreate(modelExpOverrides[resolvedModel.id], () => this._fetchModel(modelExpOverrides[resolvedModel.id]));

			// Use the experimental model if it exists, otherwise fallback to the normal model we resolved
			resolvedModel = experimentalModel ?? resolvedModel;
		}
		return resolvedModel;
	}
}

//#endregion
