/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn } from '../../../vscodeTypes';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { TitlePrompt } from '../../prompts/node/panel/title';

export class ChatTitleProvider implements vscode.ChatTitleProvider {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async provideChatTitle(
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
	): Promise<string | undefined> {

		// Get the first user message directly from the context
		// Use instanceof to properly check if the first item is a ChatRequestTurn
		const firstRequest = context.history.find(item => item instanceof ChatRequestTurn);
		if (!firstRequest) {
			return '';
		}

		const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');
		const { messages } = await renderPromptElement(this.instantiationService, endpoint, TitlePrompt, { userRequest: firstRequest.prompt });
		const response = await endpoint.makeChatRequest2({
			debugName: 'title',
			messages,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			userInitiatedRequest: false,
			isConversationRequest: false,
		}, token);
		if (token.isCancellationRequested) {
			return '';
		}

		if (response.type === ChatFetchResponseType.Success) {
			let title = response.value.trim();
			if (title.match(/^".*"$/)) {
				title = title.slice(1, -1);
			}

			if (title.includes('can\'t assist with that')) {
				return undefined;
			}

			return title;
		} else {
			this.logService.error(`Failed to fetch conversation title because of response type (${response.type}) and reason (${response.reason})`);
			return '';
		}
	}
}
