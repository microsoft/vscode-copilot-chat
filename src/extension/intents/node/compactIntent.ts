/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext, IIntentSlashCommandInfo, NullIntentInvocation } from '../../prompt/node/intents';
import { ConversationHistorySummarizationPrompt } from '../../prompts/node/agent/summarizedConversationHistory';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';

/**
 * The /compact intent triggers manual summarization of the conversation history.
 * This allows users to explicitly compact their chat context rather than relying
 * on automatic compaction.
 */
export class CompactIntent implements IIntent {
	static readonly ID = Intent.Compact;
	readonly id = CompactIntent.ID;
	readonly locations = [ChatLocation.Panel];
	readonly description = l10n.t('Summarize the conversation history to reduce context size');
	readonly commandInfo: IIntentSlashCommandInfo = {
		allowsEmptyArgs: true,
	};

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ILogService private readonly logService: ILogService,
	) { }

	async invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// Note: When handleRequest is defined, invoke is not called.
		// This is a fallback that returns a NullIntentInvocation.
		const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');
		return new NullIntentInvocation(this, invocationContext.location, endpoint);
	}

	async handleRequest(
		conversation: Conversation,
		_request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken,
		_documentContext: IDocumentContext | undefined,
		_agentName: string,
		_location: ChatLocation,
		_chatTelemetry: ChatTelemetryBuilder,
		_onPaused: Event<boolean>,
	): Promise<vscode.ChatResult> {
		// Get turns from conversation, excluding the current turn (the /compact request itself)
		const turns = conversation.turns.slice(0, -1);

		if (turns.filter(t => t.responseStatus === TurnStatus.Success).length === 0) {
			stream.markdown(l10n.t('Unable to generate a summary. The conversation may be too short or empty.'));
			return {};
		}

		stream.progress(l10n.t('Summarizing conversation history...'));

		const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');
		const promptContext: IBuildPromptContext = {
			requestId: 'chat-compact',
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
			this.logService.error(`[CompactIntent] Failed to render conversation summarization prompt: ${err instanceof Error ? err.message : String(err)}`);
			stream.markdown(l10n.t('Unable to generate a summary due to an error.'));
			return {};
		}

		const response = await endpoint.makeChatRequest(
			'compact',
			allMessages,
			undefined,
			token,
			ChatLocation.Panel,
			undefined,
			undefined,
			false
		);

		if (token.isCancellationRequested) {
			return {};
		}

		if (response.type === ChatFetchResponseType.Success) {
			let summary = response.value.trim();
			if (summary.match(/^".*"$/)) {
				summary = summary.slice(1, -1);
			}
			stream.markdown(l10n.t('**Conversation Summary**\n\n'));
			stream.markdown(summary);
		} else {
			this.logService.error(`[CompactIntent] Failed to fetch conversation summary because of response type (${response.type}) and reason (${response.reason})`);
			stream.markdown(l10n.t('Unable to generate a summary due to an error.'));
		}

		return {};
	}
}
