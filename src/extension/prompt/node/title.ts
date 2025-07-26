/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { TitlePrompt } from '../../prompts/node/panel/title';
import { TurnStatus } from '../common/conversation';
import { addHistoryToConversation } from './chatParticipantRequestHandler';

export class ChatTitleProvider implements vscode.ChatTitleProvider {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async provideChatTitle(
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
	): Promise<string> {

		const { turns } = this.instantiationService.invokeFunction(accessor => addHistoryToConversation(accessor, context.history));
		if (turns.filter(t => t.responseStatus === TurnStatus.Success).length === 0) {
			return '';
		}

		const endpoint = await this.endpointProvider.getChatEndpoint('gpt-4o-mini');
		const { messages } = await renderPromptElement(this.instantiationService, endpoint, TitlePrompt, { history: turns });
		const response = await endpoint.makeChatRequest(
			'title',
			messages,
			undefined,
			token,
			ChatLocation.Panel,
			undefined,
			undefined,
			false
		);

		if (token.isCancellationRequested) {
			return '';
		}

		if (response.type === ChatFetchResponseType.Success) {
			let title = response.value.trim();
			if (title.match(/^".*"$/)) {
				title = title.slice(1, -1);
			}

			return title;
		} else {
			this.logService.error(`Failed to fetch conversation title because of response type (${response.type}) and reason (${response.reason})`);
			return '';
		}
	}
}
