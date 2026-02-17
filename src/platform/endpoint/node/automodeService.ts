/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TimeoutTimer } from '../../../util/vs/base/common/async';
import { Disposable, DisposableMap } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../vscodeTypes';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICAPIClientService } from '../common/capiClient';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { RouterDecisionFetcher } from './routerDecisionFetcher';

interface AutoModeAPIResponse {
	available_models: string[];
	selected_model: string;
	expires_at: number;
	discounted_costs?: { [key: string]: number };
	session_token: string;
}

class AutoModeTokenBank extends Disposable {
	private _token: AutoModeAPIResponse | undefined;
	private _fetchTokenPromise: Promise<void> | undefined;
	private _refreshTimer: TimeoutTimer;
	private _usedSinceLastFetch = false;

	constructor(
		public debugName: string,
		private readonly _location: ChatLocation,
		private readonly _capiClientService: ICAPIClientService,
		private readonly _authService: IAuthenticationService,
		private readonly _logService: ILogService,
		private readonly _expService: IExperimentationService,
		private readonly _envService: IEnvService
	) {
		super();
		this._refreshTimer = this._register(new TimeoutTimer());
		this._register(this._envService.onDidChangeWindowState((state) => {
			if (state.active && this._usedSinceLastFetch && (!this._token || this._token.expires_at * 1000 - Date.now() < 5 * 60 * 1000)) {
				// Window is active again, fetch a new token if it's expiring soon or we don't have one
				this._fetchTokenPromise = this._fetchToken();
			}
		}));
		this._fetchTokenPromise = this._fetchToken();
	}

	async getToken(): Promise<AutoModeAPIResponse> {
		if (!this._token) {
			if (this._fetchTokenPromise) {
				await this._fetchTokenPromise;
			}
			// If we still don't have a token (e.g., the awaited promise returned nothing), force a new fetch
			if (!this._token) {
				this._fetchTokenPromise = this._fetchToken(true);
				await this._fetchTokenPromise;
			}
		}
		if (!this._token) {
			throw new Error(`[${this.debugName}] Failed to fetch AutoMode token: token is undefined after fetch attempt.`);
		}
		this._usedSinceLastFetch = true;
		return this._token;
	}


	private async _fetchToken(force?: boolean): Promise<void> {
		// If the window isn't active we will skip fetching to save network calls
		// We will fetch again when the window becomes active
		if (!this._envService.isActive && !force) {
			return;
		}
		const startTime = Date.now();

		const authToken = (await this._authService.getCopilotToken()).token;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${authToken}`
		};
		if (this._token) {
			headers['Copilot-Session-Token'] = this._token.session_token;
		}

		const expName = this._location === ChatLocation.Editor
			? 'copilotchat.autoModelHint.editor'
			: 'copilotchat.autoModelHint';

		const autoModeHint = this._expService.getTreatmentVariable<string>(expName) || 'auto';

		const response = await this._capiClientService.makeRequest<Response>({
			json: {
				'auto_mode': { 'model_hints': [autoModeHint] }
			},
			headers,
			method: 'POST'
		}, { type: RequestType.AutoModels });
		const data: AutoModeAPIResponse = await response.json() as AutoModeAPIResponse;
		this._logService.trace(`Fetched auto model for ${this.debugName} in ${Date.now() - startTime}ms.`);
		this._token = data;
		this._usedSinceLastFetch = false;
		// Trigger a refresh 5 minutes before expiration
		if (!this._store.isDisposed) {
			this._refreshTimer.cancelAndSet(() => {
				if (!this._usedSinceLastFetch) {
					this._logService.trace(`[${this.debugName}] Skipping auto mode token refresh because it was not used since last fetch.`);
					this._token = undefined;
					return;
				}
				this._fetchToken();
			}, (data.expires_at * 1000) - Date.now() - 5 * 60 * 1000);
		}
		this._fetchTokenPromise = undefined;
	}
}

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IAutomodeService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint>;
}

export class AutomodeService extends Disposable implements IAutomodeService {
	readonly _serviceBrand: undefined;
	private readonly _autoModelCache: Map<string, { endpoints: AutoChatEndpoint[]; tokenBank: AutoModeTokenBank; lastSessionToken?: string; lastRoutedPrompt?: string }> = new Map();
	private _reserveTokens: DisposableMap<ChatLocation, AutoModeTokenBank> = new DisposableMap();
	private readonly _routerDecisionFetcher: RouterDecisionFetcher;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvService private readonly _envService: IEnvService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			for (const entry of this._autoModelCache.values()) {
				entry.tokenBank.dispose();
			}
			this._autoModelCache.clear();
			const keys = Array.from(this._reserveTokens.keys());
			this._reserveTokens.clearAndDisposeAll();
			for (const location of keys) {
				this._reserveTokens.set(location, new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService, this._envService));
			}
		}));
		this._serviceBrand = undefined;
		this._routerDecisionFetcher = this._register(new RouterDecisionFetcher(this._fetcherService, this._logService, this._configurationService, this._expService, this._telemetryService));
	}

	override dispose(): void {
		for (const entry of this._autoModelCache.values()) {
			entry.tokenBank.dispose();
		}
		this._autoModelCache.clear();
		this._reserveTokens.dispose();
		super.dispose();
	}

	/**
	 * Resolve an auto mode endpoint using a double-buffer strategy and a global reserve token.
	 */
	async resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		if (!knownEndpoints.length) {
			throw new Error('No auto mode endpoints provided.');
		}

		// Only use router model for panel chat to avoid latency penalty in inline chat
		const isPanelChat = !chatRequest?.location || chatRequest?.location === ChatLocation.Panel;
		const usingRouterModel = isPanelChat && this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.AutoModeRouterUrl, this._expService) !== undefined;
		if (usingRouterModel) {
			return this._resolveWithRouterModel(chatRequest, knownEndpoints);
		}
		return this._resolveWithoutRouterModel(chatRequest, knownEndpoints);
	}

	/**
	 * Router model path: Uses the router decision fetcher to select the best model based on the prompt.
	 * This is an experimental feature that can be removed once the experiment is complete.
	 */
	private async _resolveWithRouterModel(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const conversationId = getConversationId(chatRequest);
		const entry = this._autoModelCache.get(conversationId);
		const location = chatRequest?.location ?? ChatLocation.Panel;
		const reserveTokenBank = this._reserveTokens.get(location) || new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService, this._envService);
		this._reserveTokens.set(location, new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService, this._envService));

		// Update the debug name so logs are properly associating this token with the right conversation id now
		reserveTokenBank.debugName = conversationId;

		const reserveToken = await reserveTokenBank.getToken();

		let selectedModel: IChatEndpoint | undefined = undefined;
		const availableModels = reserveToken.available_models;
		const cachedModels = entry?.endpoints.map(e => e.model) || [];
		// preferredModels is an ordered list used to express routing preference:
		//  - the reserved model is always first
		//  - followed by any cached models in their original order, without duplicates
		const preferredModels = [reserveToken.selected_model];
		for (const cachedModel of cachedModels) {
			if (!preferredModels.includes(cachedModel)) {
				preferredModels.push(cachedModel);
			}
		}

		// Only call the router if the prompt has changed since the last routing decision.
		// This ensures routing happens once per turn (user message), not on every iteration
		// during tool calling where the prompt remains the same.
		const prompt = chatRequest?.prompt?.trim();
		const shouldRoute = prompt?.length && (!entry || entry.lastRoutedPrompt !== prompt);
		if (shouldRoute) {
			try {
				const routedModel = await this._routerDecisionFetcher.getRoutedModel(prompt, availableModels, preferredModels);
				selectedModel = knownEndpoints.find(e => e.model === routedModel);
			} catch (e) {
				this._logService.error(`Failed to get routed model for conversation ${conversationId}: `, (e as Error).message);
			}
		}
		if (!selectedModel) {
			selectedModel = knownEndpoints.find(e => e.model === reserveToken.selected_model);
			if (!selectedModel) {
				const errorMsg = `Auto mode failed: selected model '${reserveToken.selected_model}' not found in known endpoints.`;
				this._logService.error(errorMsg);
				throw new Error(errorMsg);
			}
			if (shouldRoute) {
				// If routing was attempted but failed, emit event that we are falling back to the reserved model
				{
					/* __GDPR__
						"automode.routerDecisionFallback" : {
							"owner": "tyleonha",
							"comment": "Reports a fallback event when the router fails to return a valid model and we have to fall back to the reserved model.",
							"availableModels": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Comma-separated list of available models for this request" },
							"preferredModels": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Comma-separated list of preferred models for this request, ordered by preference with the reserved model first" },
							"chosenModel": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The fallback model used when router fails" }
						}
					*/
					this._telemetryService.sendMSFTTelemetryEvent('automode.routerDecisionFallback', {
						'availableModels': availableModels.join(','),
						'preferredModels': preferredModels.join(','),
						'chosenModel': selectedModel.model,
					})
				}
			}
		}
		selectedModel = this._applyVisionFallback(chatRequest, selectedModel, reserveToken.available_models, knownEndpoints);

		// If the session token changed, invalidate all cached endpoints so they get recreated with the new token
		const existingEndpoints = (entry && entry.lastSessionToken === reserveToken.session_token) ? entry.endpoints : [];
		let autoEndpoint = existingEndpoints.find(e => e.model === selectedModel.model);
		if (!autoEndpoint) {
			autoEndpoint = this._instantiationService.createInstance(AutoChatEndpoint, selectedModel, reserveToken.session_token, reserveToken.discounted_costs?.[selectedModel.model] || 0, this._calculateDiscountRange(reserveToken.discounted_costs));
			existingEndpoints.push(autoEndpoint);
		}
		this._autoModelCache.set(conversationId, { endpoints: existingEndpoints, tokenBank: reserveTokenBank, lastSessionToken: reserveToken.session_token, lastRoutedPrompt: prompt });
		return autoEndpoint;
	}

	/**
	 * Non-router model path: Uses the cached endpoint if available, or falls back to the reserved token's selected model.
	 */
	private async _resolveWithoutRouterModel(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const conversationId = getConversationId(chatRequest);
		const entry = this._autoModelCache.get(conversationId);

		// If we have a cached entry, use it (refreshing if the model changed)
		if (entry) {
			const entryToken = await entry.tokenBank.getToken();
			if (entry.endpoints.length && (entry.endpoints[0].model !== entryToken.selected_model || entry.lastSessionToken !== entryToken.session_token)) {
				// Model or session token changed during a token refresh -> map to new endpoint
				const newModel = knownEndpoints.find(e => e.model === entryToken.selected_model);
				if (!newModel) {
					const errorMsg = `Auto mode failed: selected model '${entryToken.selected_model}' not found in known endpoints.`;
					this._logService.error(errorMsg);
					throw new Error(errorMsg);
				}
				entry.endpoints = [this._instantiationService.createInstance(AutoChatEndpoint, newModel, entryToken.session_token, entryToken.discounted_costs?.[newModel.model] || 0, this._calculateDiscountRange(entryToken.discounted_costs))];
				entry.lastSessionToken = entryToken.session_token;
			}
			// Apply vision fallback even on cached entries, since the cached model may not support images
			const cachedEndpoint = entry.endpoints[0];
			const fallbackEndpoint = this._applyVisionFallback(chatRequest, cachedEndpoint, entryToken.available_models, knownEndpoints);
			if (fallbackEndpoint !== cachedEndpoint) {
				const autoEndpoint = this._instantiationService.createInstance(AutoChatEndpoint, fallbackEndpoint, entryToken.session_token, entryToken.discounted_costs?.[fallbackEndpoint.model] || 0, this._calculateDiscountRange(entryToken.discounted_costs));
				entry.endpoints[0] = autoEndpoint;
				return autoEndpoint;
			}
			return cachedEndpoint;
		}

		// No cached entry, use the reserve token
		const location = chatRequest?.location ?? ChatLocation.Panel;
		const reserveTokenBank = this._reserveTokens.get(location) || new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService, this._envService);
		this._reserveTokens.set(location, new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService, this._envService));
		reserveTokenBank.debugName = conversationId;

		const reserveToken = await reserveTokenBank.getToken();
		let selectedModel = knownEndpoints.find(e => e.model === reserveToken.selected_model);
		if (!selectedModel) {
			const errorMsg = `Auto mode failed: selected model '${reserveToken.selected_model}' not found in known endpoints.`;
			this._logService.error(errorMsg);
			throw new Error(errorMsg);
		}
		selectedModel = this._applyVisionFallback(chatRequest, selectedModel, reserveToken.available_models, knownEndpoints);
		const autoEndpoint = this._instantiationService.createInstance(AutoChatEndpoint, selectedModel, reserveToken.session_token, reserveToken.discounted_costs?.[selectedModel.model] || 0, this._calculateDiscountRange(reserveToken.discounted_costs));

		this._autoModelCache.set(conversationId, { endpoints: [autoEndpoint], tokenBank: reserveTokenBank, lastSessionToken: reserveToken.session_token });
		return autoEndpoint;
	}

	/**
	 * If the request contains an image and the selected model doesn't support vision,
	 * fall back to the first vision-capable model from the available models.
	 */
	private _applyVisionFallback(chatRequest: ChatRequest | undefined, selectedModel: IChatEndpoint, availableModels: string[], knownEndpoints: IChatEndpoint[]): IChatEndpoint {
		if (!hasImage(chatRequest) || selectedModel.supportsVision) {
			return selectedModel;
		}
		const visionModel = availableModels
			.map(model => knownEndpoints.find(e => e.model === model))
			.find(endpoint => endpoint?.supportsVision);
		if (visionModel) {
			this._logService.trace(`Selected model '${selectedModel.model}' does not support vision, falling back to '${visionModel.model}'.`);
			return visionModel;
		}
		this._logService.warn(`Request contains an image but no vision-capable model is available.`);
		return selectedModel;
	}

	private _calculateDiscountRange(discounts: Record<string, number> | undefined): { low: number; high: number } {
		if (!discounts) {
			return { low: 0, high: 0 };
		}
		let low = Infinity;
		let high = -Infinity;
		let hasValues = false;

		for (const value of Object.values(discounts)) {
			hasValues = true;
			if (value < low) {
				low = value;
			}
			if (value > high) {
				high = value;
			}
		}
		return hasValues ? { low, high } : { low: 0, high: 0 };
	}
}

/**
 * Get the conversation ID from the chat request. This is representative of a single chat thread
 * @param chatRequest The chat request object.
 * @returns The conversation ID or 'unknown' if not available.
 */
function getConversationId(chatRequest: ChatRequest | undefined): string {
	if (!chatRequest) {
		return 'unknown';
	}
	return chatRequest?.sessionId || 'unknown';
}

function hasImage(chatRequest: ChatRequest | undefined): boolean {
	if (!chatRequest || !chatRequest.references) {
		return false;
	}
	return chatRequest.references.some(ref => {
		const value = ref.value;
		return typeof value === 'object' &&
			value !== null &&
			'mimeType' in value &&
			typeof value.mimeType === 'string'
			&& value.mimeType.startsWith('image/');
	});
}
