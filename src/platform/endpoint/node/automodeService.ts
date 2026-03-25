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
import { isAbortError } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IRequestLogger } from '../../requestLogger/node/requestLogger';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICAPIClientService } from '../common/capiClient';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { RouterDecisionFetcher, RoutingContextSignals } from './routerDecisionFetcher';

interface AutoModeAPIResponse {
	available_models: string[];
	expires_at: number;
	discounted_costs?: { [key: string]: number };
	session_token: string;
}

interface AutoModelCacheEntry {
	endpoint: AutoChatEndpoint;
	tokenBank: AutoModeTokenBank;
	lastSessionToken?: string;
	lastRoutedPrompt?: string;
	routerFallbackReason?: string;
	turnCount: number;
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

		try {
			const authToken = (await this._authService.getCopilotToken()).token;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${authToken}`
			};

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
			if (!response.ok) {
				throw new Error(`Response status: ${response.status}, status text: ${response.statusText}`);
			}
			const data: AutoModeAPIResponse = await response.json() as AutoModeAPIResponse;
			// HACK: Boost the autoModeHint model to the front of the list until CAPI fixes their bug
			const hintIndex = data.available_models.indexOf(autoModeHint);
			if (hintIndex > 0) {
				data.available_models.splice(hintIndex, 1);
				data.available_models.unshift(autoModeHint);
			}
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
		} catch (err) {
			this._logService.error(`[${this.debugName}] Failed to fetch AutoMode token:`, err);
			this._token = undefined;
		} finally {
			this._fetchTokenPromise = undefined;
		}
	}
}

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IAutomodeService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint>;
}

export class AutomodeService extends Disposable implements IAutomodeService {
	readonly _serviceBrand: undefined;
	private readonly _autoModelCache: Map<string, AutoModelCacheEntry> = new Map();
	private _reserveTokens: DisposableMap<ChatLocation, AutoModeTokenBank> = new DisposableMap();
	private readonly _routerDecisionFetcher: RouterDecisionFetcher;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvService private readonly _envService: IEnvService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
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
		this._routerDecisionFetcher = new RouterDecisionFetcher(this._capiClientService, this._authService, this._logService, this._telemetryService, this._requestLogger);
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
	 * Resolve an auto mode endpoint
	 * Optionally uses a router model to select the best endpoint based on the prompt.
	 */
	async resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		if (!knownEndpoints.length) {
			throw new Error('No auto mode endpoints provided.');
		}

		const conversationId = chatRequest?.sessionResource?.toString() ?? chatRequest?.sessionId ?? 'unknown';
		const entry = this._autoModelCache.get(conversationId);
		const tokenBank = this._acquireTokenBank(entry, chatRequest?.location, conversationId);
		const token = await tokenBank.getToken();

		const routerResult = await this._tryRouterSelection(chatRequest, conversationId, entry, token, knownEndpoints);
		let selectedModel = routerResult.selectedModel;
		const lastRoutedPrompt = routerResult.lastRoutedPrompt;
		const routerFallbackReason = routerResult.fallbackReason;

		// Default model selection when router was skipped or failed
		if (!selectedModel) {
			if (routerFallbackReason) {
				/* __GDPR__
					"automode.routerFallback" : {
						"owner": "lramos15",
						"comment": "Reports when the auto mode router is skipped or fails and falls back to default model selection",
						"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The reason the router was skipped or failed (hasImage, noMatchingEndpoint, routerError, routerTimeout)" }
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('automode.routerFallback', {
					reason: routerFallbackReason,
				});
			}
			selectedModel = this._selectDefaultModel(entry?.endpoint?.modelProvider, token.available_models, knownEndpoints);
		}

		selectedModel = this._applyVisionFallback(chatRequest, selectedModel, token.available_models, knownEndpoints);

		// Reuse the cached endpoint if the session token and model haven't changed
		const autoEndpoint = (entry?.endpoint && entry.lastSessionToken === token.session_token && entry.endpoint.model === selectedModel.model)
			? entry.endpoint
			: this._instantiationService.createInstance(AutoChatEndpoint, selectedModel, token.session_token, token.discounted_costs?.[selectedModel.model] || 0, this._calculateDiscountRange(token.discounted_costs));

		const isNewTurn = !entry || lastRoutedPrompt !== entry.lastRoutedPrompt;
		this._autoModelCache.set(conversationId, {
			endpoint: autoEndpoint,
			tokenBank,
			lastSessionToken: token.session_token,
			lastRoutedPrompt,
			routerFallbackReason,
			turnCount: (entry?.turnCount ?? 0) + (isNewTurn ? 1 : 0)
		});
		return autoEndpoint;
	}

	private _acquireTokenBank(entry: AutoModelCacheEntry | undefined, location: ChatLocation | undefined, conversationId: string): AutoModeTokenBank {
		if (entry) {
			return entry.tokenBank;
		}
		const loc = location ?? ChatLocation.Panel;
		const tokenBank = this._reserveTokens.deleteAndLeak(loc) || new AutoModeTokenBank('reserve', loc, this._capiClientService, this._authService, this._logService, this._expService, this._envService);
		this._reserveTokens.set(loc, new AutoModeTokenBank('reserve', loc, this._capiClientService, this._authService, this._logService, this._expService, this._envService));
		tokenBank.debugName = conversationId;
		return tokenBank;
	}

	private async _tryRouterSelection(
		chatRequest: ChatRequest | undefined,
		conversationId: string,
		entry: AutoModelCacheEntry | undefined,
		token: AutoModeAPIResponse,
		knownEndpoints: IChatEndpoint[],
	): Promise<{ selectedModel?: IChatEndpoint; lastRoutedPrompt?: string; fallbackReason?: string }> {
		const prompt = chatRequest?.prompt?.trim();
		const lastRoutedPrompt = entry?.lastRoutedPrompt ?? prompt;

		if (hasImage(chatRequest)) {
			return { lastRoutedPrompt, fallbackReason: 'hasImage' };
		}

		if (!this._isRouterEnabled(chatRequest) || conversationId === 'unknown') {
			return { lastRoutedPrompt };
		}

		if (!prompt?.length) {
			return { lastRoutedPrompt, fallbackReason: 'emptyPrompt' };
		}

		// Prompt hasn't changed since last decision — skip router but allow endpoint refresh
		if (entry && entry.lastRoutedPrompt === prompt) {
			return { lastRoutedPrompt };
		}

		try {
			const contextSignals: RoutingContextSignals = {
				session_id: conversationId !== 'unknown' ? conversationId : undefined,
				reference_count: chatRequest?.references?.length,
				prompt_char_count: prompt.length,
				previous_model: entry?.endpoint?.model,
				turn_number: (entry?.turnCount ?? 0) + 1,
			};
			const result = await this._routerDecisionFetcher.getRouterDecision(prompt, token.session_token, token.available_models, undefined, contextSignals);

			if (!result.candidate_models.length) {
				return { lastRoutedPrompt: prompt, fallbackReason: 'emptyCandidateList' };
			}

			// Prefer same-provider model, then fall back to the router's top candidate
			const selectedModel = (entry?.endpoint && this._findSameProviderModel(entry.endpoint.modelProvider, result.candidate_models, knownEndpoints))
				?? knownEndpoints.find(e => e.model === result.candidate_models[0]);

			if (!selectedModel) {
				return { lastRoutedPrompt: prompt, fallbackReason: 'noMatchingEndpoint' };
			}

			if (result.sticky_override) {
				this._logService.trace(`[AutomodeService] Sticky routing override: confidence=${(result.confidence * 100).toFixed(1)}%, label=${result.predicted_label}, router_model=${result.candidate_models[0]}, actual_model=${selectedModel.model}`);
			}
			return { selectedModel, lastRoutedPrompt: prompt };
		} catch (e) {
			const isTimeout = isAbortError(e);
			const fallbackReason = isTimeout ? 'routerTimeout' : 'routerError';
			this._logService.error(`Failed to get routed model for conversation ${conversationId} (${fallbackReason}):`, (e as Error).message);
			return { lastRoutedPrompt: prompt, fallbackReason };
		}
	}

	private _selectDefaultModel(currentModelProvider: string | undefined, availableModels: string[], knownEndpoints: IChatEndpoint[]): IChatEndpoint {
		const selectedModel = (currentModelProvider && this._findSameProviderModel(currentModelProvider, availableModels, knownEndpoints))
			?? this._findFirstAvailableModel(availableModels, knownEndpoints);
		if (!selectedModel) {
			const errorMsg = 'Auto mode failed: no available model found in known endpoints.';
			this._logService.error(errorMsg);
			throw new Error(errorMsg);
		}
		return selectedModel;
	}

	private _isRouterEnabled(chatRequest: ChatRequest | undefined): boolean {
		const isPanelChat = !chatRequest?.location || chatRequest?.location === ChatLocation.Panel;
		return isPanelChat && this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.UseAutoModeRouting, this._expService);
	}

	/**
	 * Find the first model in available_models that has a known endpoint.
	 */
	private _findFirstAvailableModel(availableModels: string[], knownEndpoints: IChatEndpoint[]): IChatEndpoint | undefined {
		for (const model of availableModels) {
			const endpoint = knownEndpoints.find(e => e.model === model);
			if (endpoint) {
				return endpoint;
			}
		}
		return undefined;
	}

	/**
	 * Find the first model in available_models whose knownEndpoint has the same modelProvider
	 * as the current model. Skips any model that doesn't have a known endpoint.
	 */
	private _findSameProviderModel(currentModelProvider: string, availableModels: string[], knownEndpoints: IChatEndpoint[]): IChatEndpoint | undefined {
		for (const model of availableModels) {
			const endpoint = knownEndpoints.find(e => e.model === model);
			if (endpoint && endpoint.modelProvider === currentModelProvider) {
				return endpoint;
			}
		}
		return undefined;
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
