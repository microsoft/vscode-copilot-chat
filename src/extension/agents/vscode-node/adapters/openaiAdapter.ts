/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAI, Raw } from '@vscode/prompt-tsx';
import * as http from 'http';
import * as vscode from 'vscode';
import { convertToApiChatMessage } from '../../../../platform/endpoint/vscode-node/extChatEndpoint';
import { OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { ChatRole } from '../../../../platform/networking/common/openai';
import { IParsedRequest, IProtocolAdapter, IStreamEventData, IStreamingContext } from './types';

interface OpenAIServerRequest {
	model?: string;
	messages: OpenAI.ChatMessage[];
	tools?: OpenAiFunctionTool[];
}

export class OpenAIAdapter implements IProtocolAdapter {
	parseRequest(body: string): IParsedRequest {
		const request: OpenAIServerRequest = JSON.parse(body);

		// Apply model mapping
		if (request.model?.startsWith('claude-3-5-haiku')) {
			request.model = 'gpt-4o-mini';
		}
		if (request.model?.startsWith('claude-sonnet-4')) {
			request.model = 'claude-sonnet-4';
		}

		// Convert messages to VS Code format
		const rawMessages: Raw.ChatMessage[] = request.messages.map(msg => {
			const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
			if (msg.role === ChatRole.Tool) {
				return {
					role: Raw.ChatRole.Tool,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: contentStr }],
					toolCallId: msg.tool_call_id ?? ''
				} satisfies Raw.ToolChatMessage;
			} else if (msg.role === ChatRole.Assistant) {
				return {
					role: Raw.ChatRole.Assistant,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: contentStr }],
					toolCalls: msg.tool_calls
				} satisfies Raw.AssistantChatMessage;
			} else if (msg.role === ChatRole.User) {
				return {
					role: Raw.ChatRole.User,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: contentStr }]
				} satisfies Raw.UserChatMessage;
			} else if (msg.role === ChatRole.System) {
				return {
					role: Raw.ChatRole.System,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: contentStr }]
				} satisfies Raw.SystemChatMessage;
			}

			return msg;
		}) as any;

		const vscodeMessages = convertToApiChatMessage(rawMessages);

		const tools = request.tools?.map(tool => ({
			name: tool.function.name,
			description: tool.function.description,
			inputSchema: tool.function.parameters || {},
			invoke: async () => { throw new Error('Tool invocation not supported in server mode'); }
		}));

		return {
			model: request.model,
			messages: vscodeMessages as any,
			options: {
				tools
			}
		};
	}

	formatStreamResponse(
		part: vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart,
		context: IStreamingContext
	): IStreamEventData[] {
		if (part instanceof vscode.LanguageModelTextPart) {
			const data = JSON.stringify({
				id: context.requestId,
				object: 'chat.completion.chunk',
				created: Date.now(),
				model: context.modelId,
				service_tier: 'default',
				system_fingerprint: null,
				choices: [{ index: 0, delta: { content: part.value }, logprobs: null, finish_reason: null }]
			});
			return [{ event: 'chunk', data }];
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			context.hadToolCalls = true;
			const data = JSON.stringify({
				id: context.requestId,
				object: 'chat.completion.chunk',
				created: Date.now(),
				model: context.modelId,
				service_tier: 'default',
				system_fingerprint: null,
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							function: {
								name: part.name,
								arguments: JSON.stringify(part.input)
							}
						}]
					}
				}],
			});
			return [{ event: 'tool_call', data }];
		}

		return [];
	}

	generateFinalEvents(context: IStreamingContext): IStreamEventData[] {
		const data = JSON.stringify({
			id: context.requestId,
			object: 'chat.completion.chunk',
			created: Date.now(),
			model: context.modelId,
			service_tier: 'default',
			system_fingerprint: null,
			choices: [{
				index: 0,
				delta: { content: '' },
				logprobs: null,
				finish_reason: context.hadToolCalls ? 'tool_calls' : 'stop'
			}]
		});
		return [{ event: 'chunk', data }];
	}

	getContentType(): string {
		return 'text/event-stream';
	}

	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined {
		return headers['x-nonce'] as string | undefined;
	}
}
