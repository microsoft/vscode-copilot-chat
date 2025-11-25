/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TaskSingler } from '../../../util/common/taskSingler';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../vscodeTypes';
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

/**
 * Represents a cached auto mode token and the endpoint it maps to.
 */
interface CachedAutoToken {
	readonly endpoint: IChatEndpoint;
	readonly expiration: number;
	readonly sessionToken: string;
}

/**
 * Holds the active and standby tokens for a conversation.
 */
interface ConversationCacheEntry {
	active?: CachedAutoToken;
	standby?: CachedAutoToken;
}

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IAutomodeService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint>;
}

export class AutomodeService extends Disposable implements IAutomodeService {
	readonly _serviceBrand: undefined;
	private readonly _autoModelCache: Map<string, ConversationCacheEntry> = new Map();
	private readonly _reserveTokens: Map<ChatLocation, CachedAutoToken> = new Map();
	private readonly _taskSingler = new TaskSingler<CachedAutoToken>();


	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			this._autoModelCache.clear();
			this._reserveTokens.clear();
		}));
		this._serviceBrand = undefined;
	}

	/**
	 * Resolve an auto mode endpoint using a double-buffer strategy and a global reserve token.
	 */
	async resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		if (!knownEndpoints.length) {
			throw new Error('No auto mode endpoints provided.');
		}

		const conversationId = getConversationId(chatRequest);
		const entry = this._autoModelCache.get(conversationId) ?? {};
		if (!this._autoModelCache.has(conversationId)) {
			this._autoModelCache.set(conversationId, entry);
		}

		this._pruneExpiredTokens(entry);
		if (!entry.active && entry.standby) {
			entry.active = entry.standby;
			entry.standby = undefined;
		}

		const location = chatRequest?.location ?? ChatLocation.Editor;
		if (!entry.active) {
			entry.active = await this._acquireActiveToken(conversationId, location, entry, knownEndpoints);
		}

		if (!entry.standby || !this._isTokenValid(entry.standby) || this._isExpiringSoon(entry.standby) || this._isExpiringSoon(entry.active)) {
			this._refreshStandbyInBackground(conversationId, location, entry, knownEndpoints);
		}

		this._ensureReserveRefill(knownEndpoints);
		return entry.active.endpoint;
	}

	/**
	 * Acquire or refresh the reserve token so that a future conversation can respond instantly.
	 */
	private _ensureReserveRefill(knownEndpoints: IChatEndpoint[]): void {

		for (const [location, token] of this._reserveTokens) {

			if (this._isTokenValid(token)) {
				continue;
			}

			void this._taskSingler.getOrCreate(`reserve/${location}`, () => this._fetchToken('reserve', location, undefined, knownEndpoints))
				.then(token => {
					this._reserveTokens.set(location, token);
				})
				.catch(err => {
					this._logService.error(`Failed to refresh reserve auto mode token: ${err instanceof Error ? err.message : String(err)}`);
				});
		}
	}

	/**
	 * Acquire the active token for a conversation, promoting the reserve if available.
	 */
	private async _acquireActiveToken(conversationId: string, location: ChatLocation, entry: ConversationCacheEntry, knownEndpoints: IChatEndpoint[]): Promise<CachedAutoToken> {
		const token = this._reserveTokens.get(location);
		if (this._isTokenValid(token)) {
			this._reserveTokens.delete(location);
			return token;
		}

		const sessionHint = entry.standby?.sessionToken ?? entry.active?.sessionToken;
		return this._taskSingler.getOrCreate(`active:${conversationId}`, () => this._fetchToken('active', location, sessionHint, knownEndpoints));
	}

	/**
	 * Start a background refresh to populate or update the standby token.
	 */
	private _refreshStandbyInBackground(conversationId: string, location: ChatLocation, entrySnapshot: ConversationCacheEntry, knownEndpoints: IChatEndpoint[]): void {
		const sessionHint = entrySnapshot.standby?.sessionToken ?? entrySnapshot.active?.sessionToken;
		void this._taskSingler.getOrCreate(`standby:${conversationId}`, () => this._fetchToken('standby', location, sessionHint, knownEndpoints))
			.then(token => {
				const entry = this._autoModelCache.get(conversationId);
				if (!entry) {
					return;
				}
				if (entry.active && entry.active.sessionToken === token.sessionToken) {
					return;
				}
				entry.standby = token;
			})
			.catch(err => {
				this._logService.error(`Failed to refresh standby auto mode token for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	/**
	 * Fetch a new token from the auto mode service.
	 */
	private async _fetchToken(debugName: string, location: ChatLocation, sessionToken: string | undefined, knownEndpoints: IChatEndpoint[]): Promise<CachedAutoToken> {
		const startTime = Date.now();

		const authToken = (await this._authService.getCopilotToken()).token;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${authToken}`
		};
		if (sessionToken) {
			headers['Copilot-Session-Token'] = sessionToken;
		}

		const expName = location === ChatLocation.Editor
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
		const selectedModel = knownEndpoints.find(e => e.model === data.selected_model) || knownEndpoints[0];
		const autoEndpoint = this._instantiationService.createInstance(AutoChatEndpoint, selectedModel, data.session_token, data.discounted_costs?.[selectedModel.model] || 0, this._calculateDiscountRange(data.discounted_costs));
		this._logService.trace(`Fetched auto model for ${debugName} in ${Date.now() - startTime}ms.`);
		return {
			endpoint: autoEndpoint,
			expiration: data.expires_at * 1000,
			sessionToken: data.session_token
		};
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
	 * Remove expired tokens so they are not considered during promotion.
	 */
	private _pruneExpiredTokens(entry: ConversationCacheEntry): void {
		if (entry.active && !this._isTokenValid(entry.active)) {
			entry.active = undefined;
		}
		if (entry.standby && !this._isTokenValid(entry.standby)) {
			entry.standby = undefined;
		}
	}

	/**
	 * Determine whether a token is still valid.
	 */
	private _isTokenValid(token: CachedAutoToken | undefined): token is CachedAutoToken {
		return !!token && token.expiration > Date.now();
	}

	/**
	 * Determine whether a token should be refreshed soon.
	 */
	private _isExpiringSoon(token: CachedAutoToken | undefined): boolean {
		if (!token) {
			return false;
		}
		return token.expiration - Date.now() <= 5 * 60 * 1000;
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
