/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TaskSingler } from '../../../util/common/taskSingler';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint } from '../../networking/common/networking';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { ICAPIClientService } from './capiClient';

interface AutoModeAPIResponse {
	available_models: string[];
	selected_model: string;
	expires_at: number;
	discounted_costs?: { [key: string]: number };
	session_token: string;
}

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IAutomodeService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint>;
}

export class AutomodeService implements IAutomodeService {
	readonly _serviceBrand: undefined;
	private readonly _autoModelCache: Map<string, { endpoint: IChatEndpoint; expiration: number; autoModeToken: string; lastRequestId?: string }> = new Map();
	private readonly _taskSingler = new TaskSingler<IChatEndpoint>();


	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IChatMLFetcher private readonly _chatMLFetcher: IChatMLFetcher,
	) {
		this._serviceBrand = undefined;
	}

	private async _updateAutoEndpointCache(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const startTime = Date.now();
		const conversationId = getConversationId(chatRequest);
		const cacheEntry = this._autoModelCache.get(conversationId);
		const existingToken = cacheEntry?.autoModeToken;
		const isExpired = cacheEntry && (cacheEntry.expiration <= Date.now());
		const authToken = (await this._authService.getCopilotToken()).token;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${authToken}`
		};
		if (existingToken && !isExpired) {
			headers['Copilot-Session-Token'] = existingToken;
		}
		const response = await this._capiClientService.makeRequest<Response>({
			json: {
				"auto_mode": { "model_hints": ["auto"] },
			},
			headers,
			method: 'POST'
		}, { type: RequestType.AutoModels });
		const data: AutoModeAPIResponse = await response.json() as AutoModeAPIResponse;
		const selectedModel = knownEndpoints.find(e => e.model === data.selected_model) || knownEndpoints[0];
		const autoEndpoint = new AutoChatEndpoint(selectedModel, this._chatMLFetcher, data.session_token, data.discounted_costs?.[selectedModel.model] || 0);
		this._autoModelCache.set(conversationId, {
			endpoint: autoEndpoint,
			expiration: data.expires_at * 1000,
			autoModeToken: data.session_token,
			lastRequestId: chatRequest?.id
		});
		this._logService.info(`Fetched auto model in ${Date.now() - startTime}ms.`);
		return autoEndpoint;
	}

	async resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const cacheEntry = this._autoModelCache.get(getConversationId(chatRequest));
		const expiringSoon = cacheEntry && (cacheEntry.expiration - Date.now() < 5 * 60 * 1000);
		const isExpired = cacheEntry && (cacheEntry.expiration < Date.now());
		if (cacheEntry && !expiringSoon) { // Not expiring soon -> Return cached
			return cacheEntry.endpoint;
		} else if (cacheEntry && expiringSoon && !isExpired && chatRequest?.id === cacheEntry.lastRequestId) { // Expiring soon but the request is the same, so keep model sticky
			return cacheEntry.endpoint;
		} else { // Either no cache, it's expiring soon and a new request, or it has expired
			return this._taskSingler.getOrCreate(getConversationId(chatRequest), () => this._updateAutoEndpointCache(chatRequest, knownEndpoints));
		}
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