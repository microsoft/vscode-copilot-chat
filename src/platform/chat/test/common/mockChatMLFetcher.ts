/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../util/vs/base/common/event';
import { IChatMLFetcher } from '../../common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse, ChatResponses } from '../../common/commonTypes';

export class MockChatMLFetcher implements IChatMLFetcher {
	_serviceBrand: undefined;
	onDidMakeChatMLRequest = Event.None;

	async fetchOne(): Promise<ChatResponse> {
		return { type: ChatFetchResponseType.Success, requestId: '', serverRequestId: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }, value: '' } satisfies ChatResponse;
	}

	async fetchMany(): Promise<ChatResponses> {
		return { type: ChatFetchResponseType.Success, requestId: '', serverRequestId: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }, value: [''] } satisfies ChatResponses;
	}
}
