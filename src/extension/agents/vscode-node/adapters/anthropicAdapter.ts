/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as http from 'http';
import * as vscode from 'vscode';
import { LanguageModelChatMessageRole } from 'vscode';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { anthropicMessageParamsToApiMessages } from '../../../byok/vscode-node/anthropicMessageConverter';
import { ParsedRequest, ProtocolAdapter, StreamEventData, StreamingContext } from './types';

export class AnthropicAdapter implements ProtocolAdapter {
	parseRequest(body: string): ParsedRequest {
		const requestBody: Anthropic.MessageStreamParams = JSON.parse(body);

		// Convert Anthropic messages to VS Code format
		const vscodeMessages: vscode.LanguageModelChatMessage[] = [];

		// Add system messages first
		if (typeof requestBody.system === 'string') {
			vscodeMessages.push(new vscode.LanguageModelChatMessage(LanguageModelChatMessageRole.System, requestBody.system));
		} else if (Array.isArray(requestBody.system) && requestBody.system.length > 0) {
			const systemContent = requestBody.system.map(s => s.text).join('\n');
			vscodeMessages.push(new vscode.LanguageModelChatMessage(LanguageModelChatMessageRole.System, systemContent));
		}

		// Add conversation messages
		requestBody.messages.forEach(msg => {
			vscodeMessages.push(...anthropicMessageParamsToApiMessages(msg));
		});

		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'Anthropic-compatible chat request',
			modelOptions: {
				temperature: 0
			}
		};

		if (requestBody.tools && requestBody.tools.length > 0) {
			// Convert Anthropic tools to VS Code tools
			options.tools = coalesce(requestBody.tools.map(tool => {
				if ('input_schema' in tool) {
					return {
						name: tool.name,
						description: tool.description || '',
						inputSchema: tool.input_schema || {},
					};
				} else {
					// unsupported tool
					return undefined;
				}
			}));
		}

		return {
			model: requestBody.model,
			messages: vscodeMessages,
			options
		};
	}

	formatStreamResponse(
		part: vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart,
		context: StreamingContext
	): StreamEventData[] {
		const events: StreamEventData[] = [];

		if (part instanceof vscode.LanguageModelTextPart) {
			if (!context.hasTextBlock) {
				// Send content_block_start for text
				const contentBlockStart: Anthropic.RawContentBlockStartEvent = {
					type: 'content_block_start',
					index: context.currentBlockIndex,
					content_block: {
						type: 'text',
						text: '',
						citations: null
					}
				};
				events.push({
					event: contentBlockStart.type,
					data: JSON.stringify(contentBlockStart).replace(/\n/g, '\\n')
				});
				context.hasTextBlock = true;
			}

			// Send content_block_delta for text
			const contentDelta: Anthropic.RawContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: context.currentBlockIndex,
				delta: {
					type: 'text_delta',
					text: part.value
				}
			};
			events.push({
				event: contentDelta.type,
				data: JSON.stringify(contentDelta).replace(/\n/g, '\\n')
			});

			// Count tokens
			context.outputTokens += part.value.split(/\s+/).filter(Boolean).length;

		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			// End current text block if it exists
			if (context.hasTextBlock) {
				const contentBlockStop: Anthropic.RawContentBlockStopEvent = {
					type: 'content_block_stop',
					index: context.currentBlockIndex
				};
				events.push({
					event: contentBlockStop.type,
					data: JSON.stringify(contentBlockStop).replace(/\n/g, '\\n')
				});
				context.currentBlockIndex++;
				context.hasTextBlock = false;
			}

			context.hadToolCalls = true;

			// Send tool use block
			const toolBlockStart: Anthropic.RawContentBlockStartEvent = {
				type: 'content_block_start',
				index: context.currentBlockIndex,
				content_block: {
					type: 'tool_use',
					id: part.callId,
					name: part.name,
					input: {},
				}
			};
			events.push({
				event: toolBlockStart.type,
				data: JSON.stringify(toolBlockStart).replace(/\n/g, '\\n')
			});

			// Send tool use content
			const toolBlockContent: Anthropic.RawContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: context.currentBlockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(part.input || {})
				}
			};
			events.push({
				event: toolBlockContent.type,
				data: JSON.stringify(toolBlockContent).replace(/\n/g, '\\n')
			});

			const toolBlockStop: Anthropic.RawContentBlockStopEvent = {
				type: 'content_block_stop',
				index: context.currentBlockIndex
			};
			events.push({
				event: toolBlockStop.type,
				data: JSON.stringify(toolBlockStop).replace(/\n/g, '\\n')
			});

			context.currentBlockIndex++;
		}

		return events;
	}

	generateFinalEvents(context: StreamingContext): StreamEventData[] {
		const events: StreamEventData[] = [];

		// Send final events
		if (context.hasTextBlock) {
			const contentBlockStop: Anthropic.RawContentBlockStopEvent = {
				type: 'content_block_stop',
				index: context.currentBlockIndex
			};
			events.push({
				event: contentBlockStop.type,
				data: JSON.stringify(contentBlockStop).replace(/\n/g, '\\n')
			});
		}

		const messageDelta: Anthropic.RawMessageDeltaEvent = {
			type: 'message_delta',
			delta: {
				stop_reason: context.hadToolCalls ? 'tool_use' : 'end_turn',
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
			data: JSON.stringify(messageDelta).replace(/\n/g, '\\n')
		});

		const messageStop: Anthropic.RawMessageStopEvent = {
			type: 'message_stop'
		};
		events.push({
			event: messageStop.type,
			data: JSON.stringify(messageStop).replace(/\n/g, '\\n')
		});

		return events;
	}

	generateInitialEvents(context: StreamingContext): StreamEventData[] {
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
					server_tool_use: null
				}
			}
		};

		return [{
			event: messageStart.type,
			data: JSON.stringify(messageStart).replace(/\n/g, '\\n')
		}];
	}

	getContentType(): string {
		return 'text/event-stream';
	}

	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined {
		return headers['x-api-key'] as string | undefined;
	}
}
