/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ConversationHistorySummarizationPrompt } from '../../prompts/node/agent/summarizedConversationHistory';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { TurnStatus } from '../common/conversation';
import { IBuildPromptContext } from '../common/intents';
import { addHistoryToConversation } from './chatParticipantRequestHandler';

export class ChatSummarizerProvider implements vscode.ChatSummarizer {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async provideChatSummary(
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
	): Promise<string> {

		const { turns } = this.instantiationService.invokeFunction(accessor => addHistoryToConversation(accessor, context.history));
		if (turns.filter(t => t.responseStatus === TurnStatus.Success).length === 0) {
			return '';
		}

		const endpoint = await this.endpointProvider.getChatEndpoint('gpt-4o-mini');
		const promptContext: IBuildPromptContext = {
			requestId: 'chat-summary',
			query: '',
			history: turns,
			chatVariables: new ChatVariablesCollection(),
			isContinuation: false,
			toolCallRounds: undefined,
			toolCallResults: undefined,
		};

		let allMessages: Raw.ChatMessage[];
		try {
			const rendered = await renderPromptElement(
				this.instantiationService,
				endpoint,
				ConversationHistorySummarizationPrompt,
				{
					priority: 0,
					endpoint,
					location: ChatLocation.Panel,
					promptContext,
					maxToolResultLength: 2000,
					triggerSummarize: false,
					simpleMode: false,
					maxSummaryTokens: 7_000,
				},
				undefined,
				token
			);
			allMessages = rendered.messages;
		} catch (err) {
			this.logService.error(`Failed to render conversation summarization prompt: ${err instanceof Error ? err.message : String(err)}`);
			return '';
		}

		const response = await endpoint.makeChatRequest(
			'summarize',
			allMessages,
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
			let summary = response.value.trim();
			if (summary.match(/^".*"$/)) {
				summary = summary.slice(1, -1);
			}
			return summary;
		} else {
			this.logService.error(`Failed to fetch conversation summary because of response type (${response.type}) and reason (${response.reason})`);
			return '';
		}
	}
}
