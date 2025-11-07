/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import type { OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { APIUsage } from '../../../../platform/networking/common/openai';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { IAgentStreamBlock, IParsedRequest, IProtocolAdapter, IProtocolAdapterFactory, IStreamEventData, IStreamingContext } from './types';

export class OpenAIAdapterFactory implements IProtocolAdapterFactory {
	createAdapter(): IProtocolAdapter {
		return new OpenAIAdapter();
	}
}

class OpenAIAdapter implements IProtocolAdapter {
	readonly name = 'openai';

	// Per-request state
	private currentBlockIndex = 0;
	private hasTextBlock = false;
	private hadToolCalls = false;

	parseRequest(body: string): IParsedRequest {
		const requestBody: any = JSON.parse(body);

		// Extract model information
		const model = requestBody.model;

		// Convert messages format if needed
		const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

		const options: IMakeChatRequestOptions['requestOptions'] = {
			temperature: requestBody.temperature,
			max_tokens: requestBody.max_tokens,
		};

		if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
			// Map OpenAI tools to VS Code chat tools
			const tools = coalesce(requestBody.tools.map((tool: any) => {
				if (tool.type === 'function' && tool.function) {
					const chatTool: OpenAiFunctionTool = {
						type: 'function',
						function: {
							name: tool.function.name,
							description: tool.function.description || '',
							parameters: tool.function.parameters || {},
						}
					};
					return chatTool;
				}
				return undefined;
			}));
			if (tools.length) {
				options.tools = tools as OpenAiFunctionTool[];
			}
		}

		return {
			model,
			messages,
			options
		};
	}

	formatStreamResponse(
		streamData: IAgentStreamBlock,
		context: IStreamingContext
	): IStreamEventData[] {
		const events: IStreamEventData[] = [];

		if (streamData.type === 'text') {
			if (!this.hasTextBlock) {
				this.hasTextBlock = true;
			}

			// Send text delta events
			const textDelta = {
				id: context.requestId,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: context.endpoint.modelId,
				choices: [{
					index: this.currentBlockIndex,
					delta: {
						content: streamData.content,
						role: 'assistant'
					},
					finish_reason: null
				}]
			};
			events.push({
				event: 'message',
				data: this.formatEventData(textDelta)
			});

		} else if (streamData.type === 'tool_call') {
			// End current text block if it exists
			if (this.hasTextBlock) {
				this.currentBlockIndex++;
				this.hasTextBlock = false;
			}

			this.hadToolCalls = true;

			// Send tool call events
			const toolCallDelta = {
				id: context.requestId,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: context.endpoint.modelId,
				choices: [{
					index: this.currentBlockIndex,
					delta: {
						tool_calls: [{
							index: this.currentBlockIndex,
							id: streamData.callId,
							type: 'function',
							function: {
								name: streamData.name,
								arguments: JSON.stringify(streamData.input || {})
							}
						}]
					},
					finish_reason: null
				}]
			};
			events.push({
				event: 'message',
				data: this.formatEventData(toolCallDelta)
			});

			this.currentBlockIndex++;
		}

		return events;
	}

	generateFinalEvents(context: IStreamingContext, usage?: APIUsage): IStreamEventData[] {
		const events: IStreamEventData[] = [];

		// Send final completion event with usage information
		const finalCompletion = {
			id: context.requestId,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: context.endpoint.modelId,
			choices: [{
				index: 0,
				message: {
					role: 'assistant',
					content: '',
				},
				finish_reason: this.hadToolCalls ? 'tool_calls' : 'stop'
			}],
			usage: usage ? {
				prompt_tokens: usage.prompt_tokens,
				completion_tokens: usage.completion_tokens,
				total_tokens: usage.total_tokens
			} : {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0
			}
		};

		events.push({
			event: 'message',
			data: this.formatEventData(finalCompletion)
		});

		return events;
	}

	generateInitialEvents(context: IStreamingContext): IStreamEventData[] {
		// OpenAI doesn't typically send initial events, but we can send an empty one if needed
		return [];
	}

	getContentType(): string {
		return 'text/event-stream';
	}

	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined {
		const authHeader = headers.authorization;
		const bearerSpace = 'Bearer ';
		return authHeader?.startsWith(bearerSpace) ? authHeader.substring(bearerSpace.length) : undefined;
	}

	private formatEventData(data: any): string {
		return JSON.stringify(data).replace(/\n/g, '\\n');
	}
}