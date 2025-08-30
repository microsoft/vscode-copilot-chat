/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as http from 'http';
import * as vscode from 'vscode';
import { anthropicMessagesToRawMessages } from '../../../byok/common/anthropicMessageConverter';
import { IAgentStreamBlock, IParsedRequest, IProtocolAdapter, IProtocolAdapterFactory, IStreamEventData, IStreamingContext } from './types';

export class AnthropicAdapterFactory implements IProtocolAdapterFactory {
	createAdapter(): IProtocolAdapter {
		return new AnthropicAdapter();
	}
}

class AnthropicAdapter implements IProtocolAdapter {
	// Per-request state
	private currentBlockIndex = 0;
	private hasTextBlock = false;
	private hadToolCalls = false;
	parseRequest(body: string): IParsedRequest {
		const requestBody: Anthropic.MessageStreamParams = JSON.parse(body);

		// Build a single system text block from "system" if provided
		let systemText = '';
		if (typeof requestBody.system === 'string') {
			systemText = requestBody.system;
		} else if (Array.isArray(requestBody.system) && requestBody.system.length > 0) {
			systemText = requestBody.system.map(s => s.text).join('\n');
		}

		// Convert Anthropic messages to Raw (TSX) messages
		const rawMessages = anthropicMessagesToRawMessages(requestBody.messages, { type: 'text', text: systemText });

		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'Anthropic-compatible chat request',
			modelOptions: { temperature: 0 }
		};

		if (requestBody.tools && requestBody.tools.length > 0) {
			// Map Anthropic tools to VS Code chat tools. Provide a no-op invoke since this server doesn't run tools.
			const tools = requestBody.tools.map(tool => {
				if ('input_schema' in tool) {
					const chatTool: vscode.LanguageModelChatTool = {
						name: tool.name,
						description: tool.description || '',
						inputSchema: tool.input_schema || {},
					};
					return chatTool;
				}
				return undefined;
			}).filter((t): t is vscode.LanguageModelChatTool => !!t);
			if (tools.length) {
				options.tools = tools;
			}
		}

		return {
			model: requestBody.model,
			messages: rawMessages,
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
				// Send content_block_start for text
				const contentBlockStart: Anthropic.RawContentBlockStartEvent = {
					type: 'content_block_start',
					index: this.currentBlockIndex,
					content_block: {
						type: 'text',
						text: '',
						citations: null
					}
				};
				events.push({
					event: contentBlockStart.type,
					data: this.formatEventData(contentBlockStart)
				});
				this.hasTextBlock = true;
			}

			// Send content_block_delta for text
			const contentDelta: Anthropic.RawContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: this.currentBlockIndex,
				delta: {
					type: 'text_delta',
					text: streamData.content
				}
			};
			events.push({
				event: contentDelta.type,
				data: this.formatEventData(contentDelta)
			});

		} else if (streamData.type === 'tool_call') {
			// End current text block if it exists
			if (this.hasTextBlock) {
				const contentBlockStop: Anthropic.RawContentBlockStopEvent = {
					type: 'content_block_stop',
					index: this.currentBlockIndex
				};
				events.push({
					event: contentBlockStop.type,
					data: this.formatEventData(contentBlockStop)
				});
				this.currentBlockIndex++;
				this.hasTextBlock = false;
			}

			this.hadToolCalls = true;

			// Send tool use block
			const toolBlockStart: Anthropic.RawContentBlockStartEvent = {
				type: 'content_block_start',
				index: this.currentBlockIndex,
				content_block: {
					type: 'tool_use',
					id: streamData.callId,
					name: streamData.name,
					input: {},
				}
			};
			events.push({
				event: toolBlockStart.type,
				data: this.formatEventData(toolBlockStart)
			});

			// Send tool use content
			const toolBlockContent: Anthropic.RawContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: this.currentBlockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(streamData.input || {})
				}
			};
			events.push({
				event: toolBlockContent.type,
				data: this.formatEventData(toolBlockContent)
			});

			const toolBlockStop: Anthropic.RawContentBlockStopEvent = {
				type: 'content_block_stop',
				index: this.currentBlockIndex
			};
			events.push({
				event: toolBlockStop.type,
				data: this.formatEventData(toolBlockStop)
			});

			this.currentBlockIndex++;
		}

		return events;
	}

	generateFinalEvents(context: IStreamingContext): IStreamEventData[] {
		const events: IStreamEventData[] = [];

		// Send final events
		if (this.hasTextBlock) {
			const contentBlockStop: Anthropic.RawContentBlockStopEvent = {
				type: 'content_block_stop',
				index: this.currentBlockIndex
			};
			events.push({
				event: contentBlockStop.type,
				data: this.formatEventData(contentBlockStop)
			});
		}

		const messageDelta: Anthropic.RawMessageDeltaEvent = {
			type: 'message_delta',
			delta: {
				stop_reason: this.hadToolCalls ? 'tool_use' : 'end_turn',
				stop_sequence: null
			},
			usage: {
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				input_tokens: 0,
				server_tool_use: null
			}
		};
		events.push({
			event: messageDelta.type,
			data: this.formatEventData(messageDelta)
		});

		const messageStop: Anthropic.RawMessageStopEvent = {
			type: 'message_stop'
		};
		events.push({
			event: messageStop.type,
			data: this.formatEventData(messageStop)
		});

		return events;
	}

	generateInitialEvents(context: IStreamingContext): IStreamEventData[] {
		// Calculate input tokens (rough estimate)
		const inputTokens = 100; // Placeholder - would need proper tokenization

		// Send message_start event
		const messageStart: Anthropic.RawMessageStartEvent = {
			type: 'message_start',
			message: {
				id: context.requestId,
				type: 'message',
				role: 'assistant',
				model: context.modelId,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: inputTokens,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 1,
					service_tier: null,
					server_tool_use: null,
				}
			}
		};

		return [{
			event: messageStart.type,
			data: this.formatEventData(messageStart)
		}];
	}

	getContentType(): string {
		return 'text/event-stream';
	}

	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined {
		return headers['x-api-key'] as string | undefined;
	}

	private formatEventData(data: any): string {
		return JSON.stringify(data).replace(/\n/g, '\\n');
	}
}
