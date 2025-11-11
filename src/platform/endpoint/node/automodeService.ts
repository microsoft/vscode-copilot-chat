/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TimeoutTimer } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ICAPIClientService } from '../common/capiClient';
import { AutoChatEndpoint } from './autoChatEndpoint';

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

		const autoModeHint = this._expService.getTreatmentVariable<string>('copilotchat.autoModelHint') || 'auto';

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
		this._refreshTimer.cancelAndSet(this._fetchToken.bind(this), (data.expires_at * 1000) - Date.now() - 5 * 60 * 1000);
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
	private _reserveToken: AutoModeTokenBank | undefined;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			for (const entry of this._autoModelCache.values()) {
				entry.tokenBank.dispose();
			}
			this._autoModelCache.clear();
			this._reserveToken?.dispose();
			this._reserveToken = new AutoModeTokenBank('reserve', this._capiClientService, this._authService, this._logService, this._expService);
		}));
		this._serviceBrand = undefined;
	}

	override dispose(): void {
		for (const entry of this._autoModelCache.values()) {
			entry.tokenBank.dispose();
		}
		this._autoModelCache.clear();
		this._reserveToken?.dispose();
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
		if (entry) {
			const entryToken = await entry.tokenBank.getToken();
			if (entry.endpoint.model !== entryToken.selected_model) {
				// Model changed during a token refresh -> map to new endpoint
				const newModel = knownEndpoints.find(e => e.model === entryToken.selected_model) || knownEndpoints[0];
				entry.endpoint = this._instantiationService.createInstance(AutoChatEndpoint, newModel, entryToken.session_token, entryToken.discounted_costs?.[newModel.model] || 0, this._calculateDiscountRange(entryToken.discounted_costs));
			}
			return entry.endpoint;
		}

		// No entry yet -> Promote reserve token to active and repopulate reserve
		const reserveTokenBank = this._reserveToken || new AutoModeTokenBank('reserve', this._capiClientService, this._authService, this._logService, this._expService);
		this._reserveToken = new AutoModeTokenBank('reserve', this._capiClientService, this._authService, this._logService, this._expService);

		// Update the debug name so logs are properly associating this token with the right conversation id now
		reserveTokenBank.debugName = conversationId;

		const reserveToken = await reserveTokenBank.getToken();
		const selectedModel = knownEndpoints.find(e => e.model === reserveToken.selected_model) || knownEndpoints[0];
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