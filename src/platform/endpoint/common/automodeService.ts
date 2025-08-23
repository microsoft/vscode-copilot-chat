/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { ChatRequest } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TaskSingler } from '../../../util/common/taskSingler';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatEndpoint } from '../../networking/common/networking';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { ICAPIClientService } from './capiClient';

interface AutoModeAPIResponse {
	available_models: string[];
	selected_model: string;
	expires_at: number;
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
		@IAuthenticationService private readonly _authService: IAuthenticationService
	) {
		this._serviceBrand = undefined;
	}

	private async _updateAutoEndpointCache(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const conversationId = getConversationId(chatRequest);
		const existingToken = this._autoModelCache.get(conversationId)?.autoModeToken;
		const authToken = (await this._authService.getCopilotToken()).token;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${authToken}`
		};
		if (existingToken) {
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
		const autoEndpoint = new AutoChatEndpoint(selectedModel, data.session_token);
		this._autoModelCache.set(conversationId, {
			endpoint: autoEndpoint,
			expiration: data.expires_at * 1000,
			autoModeToken: data.session_token,
			lastRequestId: chatRequest?.id
		});
		return autoEndpoint;
	}

	async resolveAutoModeEndpoint(chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		const cacheEntry = this._autoModelCache.get(getConversationId(chatRequest));
		const expiringSoon = cacheEntry && (cacheEntry.expiration - Date.now() < 5 * 60 * 1000 || 'foo'.length === 3);
		if (cacheEntry && !expiringSoon) { // Not expiring soon -> Return cached
			return cacheEntry.endpoint;
		} else if (cacheEntry && expiringSoon && chatRequest?.id === cacheEntry.lastRequestId) { // Expiring soon but the request is the same, so keep model sticky
			return cacheEntry.endpoint;
		} else { // Either no cache, or it's expiring soon and a new request
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