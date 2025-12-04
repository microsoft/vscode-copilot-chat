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
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ICAPIClientService } from '../common/capiClient';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { ReasoningClassifier } from './reasoningClassifier';

// Exact model names for reasoning-capable models (more capable, expensive models)
const REASONING_MODELS = [
	'claude-sonnet-4.5',
	'gpt-5-codex',
	'gpt-5',
	'gemini-3-pro-preview'
] as const;

// Exact model names for low/no reasoning models (fast, cheaper models)
const LOW_REASONING_MODELS = [
	'claude-haiku-4.5',
	'gpt-5-mini',
	'gpt-4.1',
	'gpt-5-nano',
	'grok-code-fast-1'
] as const;

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

	constructor(
		public debugName: string,
		private readonly _location: ChatLocation,
		private readonly _capiClientService: ICAPIClientService,
		private readonly _authService: IAuthenticationService,
		private readonly _logService: ILogService,
		private readonly _expService: IExperimentationService
	) {
		super();
		this._refreshTimer = this._register(new TimeoutTimer());
		this._fetchTokenPromise = this._fetchToken();
	}

	async getToken(): Promise<AutoModeAPIResponse> {
		if (!this._token) {
			if (this._fetchTokenPromise) {
				await this._fetchTokenPromise;
			} else {
				this._fetchTokenPromise = this._fetchToken();
				await this._fetchTokenPromise;
			}
		}
		if (!this._token) {
			throw new Error(`[${this.debugName}] Failed to fetch AutoMode token: token is undefined after fetch attempt.`);
		}
		return this._token;
	}

	private async _fetchToken(): Promise<void> {
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
		// Trigger a refresh 5 minutes before expiration
		if (!this._store.isDisposed) {
			this._refreshTimer.cancelAndSet(this._fetchToken.bind(this), (data.expires_at * 1000) - Date.now() - 5 * 60 * 1000);
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
	private readonly _autoModelCache: Map<string, { endpoint: IChatEndpoint; tokenBank: AutoModeTokenBank }> = new Map();
	private _reserveTokens: DisposableMap<ChatLocation, AutoModeTokenBank> = new DisposableMap();
	private readonly _reasoningClassifier: ReasoningClassifier;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IFetcherService private readonly _fetcherService: IFetcherService
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
				this._reserveTokens.set(location, new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService));
			}
		}));
		this._serviceBrand = undefined;

		// Initialize reasoning classifier (uses remote API)
		this._reasoningClassifier = this._register(new ReasoningClassifier(this._fetcherService, this._logService));
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

		const conversationId = getConversationId(chatRequest);
		const entry = this._autoModelCache.get(conversationId);

		// No entry yet -> Promote reserve token to active and repopulate reserve
		const location = chatRequest?.location ?? ChatLocation.Panel;
		const reserveTokenBank = this._reserveTokens.get(location) || new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService);
		this._reserveTokens.set(location, new AutoModeTokenBank('reserve', location, this._capiClientService, this._authService, this._logService, this._expService));

		// Update the debug name so logs are properly associating this token with the right conversation id now
		reserveTokenBank.debugName = conversationId;

		const reserveToken = await reserveTokenBank.getToken();

		// Check if a low reasoning model should be used based on the user's query
		const shouldUseLowReasoning = await this._shouldUseLowReasoningModel(chatRequest);

		// Check the current entry's model against the reasoning requirements and availability
		if (entry) {
			const targetModels = shouldUseLowReasoning ? LOW_REASONING_MODELS : REASONING_MODELS;
			const currentModel = entry.endpoint.model;

			// If current model is still available and matches reasoning requirements, keep it
			if (reserveToken.available_models.includes(currentModel) &&
				(targetModels as readonly string[]).includes(currentModel)) {
				this._logService.info(`Keeping current model ${currentModel} - still available and matches ${shouldUseLowReasoning ? 'low reasoning' : 'reasoning'} requirements`);
				return entry.endpoint;
			}

			this._logService.info(`Current model ${currentModel} needs to be changed - available: ${reserveToken.available_models.includes(currentModel)}, matches reasoning requirements: ${(targetModels as readonly string[]).includes(currentModel)}`);
		}

		const selectedModel = this._selectModelBasedOnReasoning(
			knownEndpoints,
			reserveToken,
			shouldUseLowReasoning
		);

		const autoEndpoint = this._instantiationService.createInstance(AutoChatEndpoint, selectedModel, reserveToken.session_token, reserveToken.discounted_costs?.[selectedModel.model] || 0, this._calculateDiscountRange(reserveToken.discounted_costs));
		this._autoModelCache.set(conversationId, { endpoint: autoEndpoint, tokenBank: reserveTokenBank });
		return autoEndpoint;
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

	/**
	 * Determines if the user's query should use a low reasoning model (for simple queries)
	 */
	private async _shouldUseLowReasoningModel(chatRequest: ChatRequest | undefined): Promise<boolean> {
		if (!chatRequest || !chatRequest.prompt || chatRequest.prompt.trim().length === 0) {
			return true;
		}

		try {
			// Use ModernBERT classifier to determine if query needs reasoning
			// Classifier outputs: 0 = reasoning required, 1 = non-reasoning (simple)
			const isSimpleQuery = await this._reasoningClassifier.classify(chatRequest.prompt);

			this._logService.info(`Low reasoning model should be used: ${isSimpleQuery}`);
			return isSimpleQuery;
		} catch (error) {
			this._logService.error('Failed to determine reasoning model requirement', error);
			return false;
		}
	}

	/**
	 * Selects the appropriate model based on reasoning requirements
	 */
	private _selectModelBasedOnReasoning(
		knownEndpoints: IChatEndpoint[],
		autoModeResponse: AutoModeAPIResponse,
		shouldUseLowReasoning: boolean
	): IChatEndpoint {
		const targetModels = shouldUseLowReasoning ? LOW_REASONING_MODELS : REASONING_MODELS;
		const modelType = shouldUseLowReasoning ? 'low reasoning' : 'reasoning';

		// First check if the server's selected_model already matches our requirements
		if ((targetModels as readonly string[]).includes(autoModeResponse.selected_model)) {
			const selectedEndpoint = knownEndpoints.find(e => e.model === autoModeResponse.selected_model);
			if (selectedEndpoint) {
				this._logService.info(`Using server's selected ${modelType} model: ${selectedEndpoint.model}`);
				return selectedEndpoint;
			}
		}

		// If selected_model doesn't match, search available_models for a match
		for (const modelName of targetModels) {
			if (autoModeResponse.available_models.includes(modelName)) {
				const endpoint = knownEndpoints.find(e => e.model === modelName);
				if (endpoint) {
					this._logService.info(`Selected ${modelType} model from available_models: ${endpoint.model}`);
					return endpoint;
				}
			}
		}

		// Fallback to the server's selected model or first available
		this._logService.info(`No matching ${modelType} model found, using server's selection: ${autoModeResponse.selected_model}`);
		return knownEndpoints.find(e => e.model === autoModeResponse.selected_model) || knownEndpoints[0];
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
	return (chatRequest?.toolInvocationToken as { sessionId: string })?.sessionId || 'unknown';
}
