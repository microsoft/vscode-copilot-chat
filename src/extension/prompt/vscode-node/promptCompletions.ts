/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { Position } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { IConversationStore } from '../../conversationStore/node/conversationStore';

export class PromptCompletionContribution extends Disposable {

	constructor(
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IConversationStore conversationStore: IConversationStore,
	) {
		super();
		const enabledObservable = configurationService.getConfigObservable(ConfigKey.Advanced.PromptCompletionsEnabled);
		this._register(autorun(reader => {
			if (!enabledObservable.read(reader)) {
				return;
			}
			reader.store.add(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'chatSessionInput' }, {
				async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
					const text = document.getText();
					const endPosition = document.validatePosition(new Position(document.lineCount, Infinity));
					if (!position.isEqual(endPosition)) {
						return Promise.resolve([]);
					}
					const prompt = [
						`You are assisting a software engineer who is writing prompts to an LLM within a code editor. The LLM is capable of generating, explaining, fixing code and generally doing programming related tasks. The software engineer has written an incomplete prompt. Your task is to complete the prompt, if necessary and if you have enough information, to send to the LLM.`,
						`Let me give you an example of a completion to a prompt. Suppose the engineer's incomplete prompt was:`,
						``,
						`Please help me`,
						``,
						`Then you could for example output the following prompt completion:`,
						``,
						` with optimizing this code.`,
						``,
						`Given your completion, the full prompt which will be visible to the engineer will be:`,
						``,
						`Please help me with optimizing this code.`,
						``,
						`Here are some additional rules for how to complete the prompt:`,
						`- Make sure the prompt completion is succinct. Do not output a paragraph unless necessary.`,
						`- Make sure the prompt completion is relevant and makes sense with the incomplete prompt. The prompt completion will be APPENDED to the incomplete prompt, so the two together should form a coherent prompt.`,
						`- Similarly, if the prompt completion starts with a new word, please add a space at the start, so that upon concatenation, the words are correctly separated.`,
						`- Please output grammatically and spelling-wise correct prompt completions.`,
						`- You DON'T always have to output a prompt completion if you think the prompt is ALREADY complete or if you don't have ENOUGH information. It is better to hold off on a completion than to give an incorrect one. In that case, just output an empty string.`,
						``,
					];
					const conversation = conversationStore.lastConversation;
					if (conversation && conversation.turns.length > 0) {
						const historyLines: string[] = [
							`I will give you, between triple backticks, the history of the prompt requests the engineer did so far to the LLM. Use this to better understand the context of the prompt being written:`,
							``,
							'```',
						];
						for (const turn of conversation.turns) {
							if (turn.request.message) {
								historyLines.push(`- ${turn.request.message}`);
							}
						}
						historyLines.push('```');
						prompt.push(...historyLines);
					}
					if (text) {
						prompt.push(...[
							`I will now give the incomplete prompt which the engineer has already written between triple backticks:`,
							``,
							'```',
							`${text}`,
							'```',
							``,
							`Given the above incomplete prompt, please provide a completion to the above prompt OR an empty string if you think a prompt completion is not necessary OR if you don't have ENOUGH information to infer a prompt completion. Do NOT include in your answer the incomplete prompt itself, just provide the completion that will be APPENDED at the end of the prompt.`,
						]);
					} else {
						prompt.push(...[
							``,
							`The software engineer has not written the beginning of a prompt yet.`
						]);
					}
					const messages: Raw.ChatMessage[] = [{
						role: Raw.ChatRole.Assistant,
						content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: prompt.join('\n') }],
					}];
					const endpoint = await endpointProvider.getChatEndpoint('gpt-5-mini');
					const response = await endpoint.makeChatRequest('promptCompletion', messages, undefined, CancellationToken.None, ChatLocation.Panel, undefined, { temperature: 0.3, top_p: 0.3 });
					if (response.type === ChatFetchResponseType.Success) {
						const insertText = response.value;
						return Promise.resolve([{
							insertText,
							range: new vscode.Range(position, position),
						}]);
					}
					return Promise.resolve([{
						insertText: '',
						range: new vscode.Range(position, position),
					}]);
				}
			}, { displayName: 'Prompt Completions' }));
		}));
	}
}