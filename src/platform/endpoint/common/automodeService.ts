/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TaskSingler } from '../../../util/common/taskSingler';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { ICAPIClientService } from './capiClient';

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
	private _reserveToken: CachedAutoToken | undefined;
	private readonly _taskSingler = new TaskSingler<CachedAutoToken>();


	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IChatMLFetcher private readonly _chatMLFetcher: IChatMLFetcher,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			this._autoModelCache.clear();
			this._reserveToken = undefined;
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

		if (!entry.active) {
			entry.active = await this._acquireActiveToken(conversationId, entry, knownEndpoints);
		}

		if (!entry.standby || !this._isTokenValid(entry.standby) || this._isExpiringSoon(entry.standby) || this._isExpiringSoon(entry.active)) {
			this._refreshStandbyInBackground(conversationId, entry, knownEndpoints);
		}

		this._ensureReserveRefill(knownEndpoints);
		return entry.active.endpoint;
	}

	/**
	 * Acquire or refresh the reserve token so that a future conversation can respond instantly.
	 */
	private _ensureReserveRefill(knownEndpoints: IChatEndpoint[]): void {
		if (this._isTokenValid(this._reserveToken)) {
			return;
		}

		void this._taskSingler.getOrCreate('reserve', () => this._fetchToken('reserve', undefined, knownEndpoints))
			.then(token => {
				this._reserveToken = token;
			})
			.catch(err => {
				this._logService.error(`Failed to refresh reserve auto mode token: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	/**
	 * Acquire the active token for a conversation, promoting the reserve if available.
	 */
	private async _acquireActiveToken(conversationId: string, entry: ConversationCacheEntry, knownEndpoints: IChatEndpoint[]): Promise<CachedAutoToken> {
		if (this._isTokenValid(this._reserveToken)) {
			const token = this._reserveToken;
			this._reserveToken = undefined;
			return token;
		}

		const sessionHint = entry.standby?.sessionToken ?? entry.active?.sessionToken;
		return this._taskSingler.getOrCreate(`active:${conversationId}`, () => this._fetchToken('active', sessionHint, knownEndpoints));
	}

	/**
	 * Start a background refresh to populate or update the standby token.
	 */
	private _refreshStandbyInBackground(conversationId: string, entrySnapshot: ConversationCacheEntry, knownEndpoints: IChatEndpoint[]): void {
		const sessionHint = entrySnapshot.standby?.sessionToken ?? entrySnapshot.active?.sessionToken;
		void this._taskSingler.getOrCreate(`standby:${conversationId}`, () => this._fetchToken('standby', sessionHint, knownEndpoints))
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
	private async _fetchToken(debugName: string, sessionToken: string | undefined, knownEndpoints: IChatEndpoint[]): Promise<CachedAutoToken> {
		const startTime = Date.now();

		const authToken = (await this._authService.getCopilotToken()).token;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${authToken}`
		};
		if (sessionToken) {
			headers['Copilot-Session-Token'] = sessionToken;
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
		const selectedModel = knownEndpoints.find(e => e.model === data.selected_model) || knownEndpoints[0];
		const autoEndpoint = new AutoChatEndpoint(selectedModel, this._chatMLFetcher, data.session_token, data.discounted_costs?.[selectedModel.model] || 0);
		this._logService.trace(`Fetched auto model for ${debugName} in ${Date.now() - startTime}ms.`);
		return {
			endpoint: autoEndpoint,
			expiration: data.expires_at * 1000,
			sessionToken: data.session_token
		};
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