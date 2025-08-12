/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { ParsedRequest, ProtocolAdapter, StreamEventData, StreamingContext } from './types';

// Anthropic API types
type AnthropicAPIUserMessageContent = (
	{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' | 'persistent' } }
	| { type: 'tool_result'; content: string; tool_use_id: string; is_error: boolean; cache_control?: { type: 'ephemeral' | 'persistent' } }
);
interface AnthropicAPIUserMessage {
	role: 'user';
	content: string | Array<AnthropicAPIUserMessageContent>;
}
type AnthropicAPIAssistantMessageContent = (
	{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' | 'persistent' } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: { type: 'ephemeral' | 'persistent' } }
);
interface AnthropicAPIAssistantMessage {
	role: 'assistant';
	content: string | Array<AnthropicAPIAssistantMessageContent>;
}
interface AnthropicAPISystemMessage {
	role: 'system';
	content: string | Array<{ type: 'text'; text: string }>;
}
type AnthropicAPIMessage = AnthropicAPIUserMessage | AnthropicAPIAssistantMessage | AnthropicAPISystemMessage;

interface AnthropicAPIMessagesRequest {
	max_tokens?: number;
	messages: Array<AnthropicAPIMessage>;
	metadata?: Record<string, unknown>;
	model?: string;
	stream?: boolean;
	system?: Array<{ type: 'text'; text: string }>;
	temperature?: number;
	tools?: Array<{
		description: string;
		name: string;
		input_schema?: Record<string, unknown>;
	}>;
}

// Response types for streaming
interface MessageStartResponseDataLine {
	type: 'message_start';
	message: {
		id: string;
		type: 'message';
		role: string;
		model: string;
		content: Array<{ type: string; text: string }>;
		stop_reason: string | null;
		stop_sequence: string | null;
		usage: {
			input_tokens: number;
			cache_creation_input_tokens: number;
			cache_read_input_tokens: number;
			output_tokens: number;
			service_tier: string;
		};
	};
}

interface ContentBlockStartResponseDataLine {
	type: 'content_block_start';
	index: number;
	content_block:
	{ type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: object };
}

interface ContentBlockDeltaResponseDataLine {
	type: 'content_block_delta';
	index: number;
	delta:
	{ type: string; text: string }
	| { type: "input_json_delta"; partial_json: string };
}

interface ContentBlockStopResponseDataLine {
	type: 'content_block_stop';
	index: number;
}

interface MessageDeltaResponseDataLine {
	type: 'message_delta';
	delta: { stop_reason: string | null; stop_sequence: string | null };
	usage: { output_tokens: number };
}

interface MessageStopResponseDataLine {
	type: 'message_stop';
}

// type AnthropicAPIMessagesStreamingResponseDataLine =
// 	| MessageStartResponseDataLine
// 	| ContentBlockStartResponseDataLine
// 	| ContentBlockDeltaResponseDataLine
// 	| ContentBlockStopResponseDataLine
// 	| MessageDeltaResponseDataLine
// 	| MessageStopResponseDataLine;

export class AnthropicAdapter implements ProtocolAdapter {
	parseRequest(body: string): ParsedRequest {
		const requestBody: AnthropicAPIMessagesRequest = JSON.parse(body);

		// Convert Anthropic messages to VS Code format
		const vscodeMessages: vscode.LanguageModelChatMessage[] = [];

		// Add system messages first
		if (requestBody.system && requestBody.system.length > 0) {
			const systemContent = requestBody.system.map(s => s.text).join('\n');
			vscodeMessages.push(vscode.LanguageModelChatMessage.User(systemContent));
		}

		// Add conversation messages
		requestBody.messages.forEach(msg => {
			if (msg.role === 'user') {
				const handleUserContent = (content: AnthropicAPIUserMessageContent) => {
					if (content.type === 'text') {
						vscodeMessages.push(vscode.LanguageModelChatMessage.User(content.text));
					} else if (content.type === 'tool_result') {
						vscodeMessages.push(vscode.LanguageModelChatMessage.User(
							[new vscode.LanguageModelToolResultPart(
								content.tool_use_id,
								[new vscode.LanguageModelTextPart(content.content)]
							)]
						));
					} else {
						throw new Error(`Unsupported user message content type: ${JSON.stringify(content)}`);
					}
				};
				if (Array.isArray(msg.content)) {
					msg.content.forEach(handleUserContent);
				} else {
					handleUserContent({ type: 'text', text: msg.content });
				}
			} else if (msg.role === 'assistant') {
				const handleAssistantContent = (content: AnthropicAPIAssistantMessageContent) => {
					if (content.type === 'text') {
						vscodeMessages.push(vscode.LanguageModelChatMessage.Assistant(content.text));
					} else if (content.type === 'tool_use') {
						const toolCall = new vscode.LanguageModelToolCallPart(
							content.id,
							content.name,
							content.input || {}
						);
						vscodeMessages.push(vscode.LanguageModelChatMessage.Assistant([toolCall]));
					} else {
						throw new Error(`Unsupported assistant message content type: ${JSON.stringify(content)}`);
					}
				};
				if (Array.isArray(msg.content)) {
					msg.content.forEach(handleAssistantContent);
				} else {
					handleAssistantContent({ type: 'text', text: msg.content });
				}
			} else if (msg.role === 'system') {
				const content = Array.isArray(msg.content)
					? msg.content.map(c => c.text).join('\n')
					: msg.content;
				vscodeMessages.push(vscode.LanguageModelChatMessage.User(content));
			}
		});

		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'Anthropic-compatible chat request'
		};

		if (requestBody.tools && requestBody.tools.length > 0) {
			// Convert Anthropic tools to VS Code tools
			options.tools = requestBody.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.input_schema || {},
				invoke: async () => { throw new Error('Tool invocation not supported in server mode'); }
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
				const contentBlockStart: ContentBlockStartResponseDataLine = {
					type: 'content_block_start',
					index: context.currentBlockIndex,
					content_block: {
						type: 'text',
						text: ''
					}
				};
				events.push({
					event: contentBlockStart.type,
					data: JSON.stringify(contentBlockStart).replace(/\n/g, '\\n')
				});
				context.hasTextBlock = true;
			}

			// Send content_block_delta for text
			const contentDelta: ContentBlockDeltaResponseDataLine = {
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
				const contentBlockStop: ContentBlockStopResponseDataLine = {
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
			const toolBlockStart: ContentBlockStartResponseDataLine = {
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
			const toolBlockContent: ContentBlockDeltaResponseDataLine = {
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

			const toolBlockStop: ContentBlockStopResponseDataLine = {
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
			const contentBlockStop: ContentBlockStopResponseDataLine = {
				type: 'content_block_stop',
				index: context.currentBlockIndex
			};
			events.push({
				event: contentBlockStop.type,
				data: JSON.stringify(contentBlockStop).replace(/\n/g, '\\n')
			});
		}

		const messageDelta: MessageDeltaResponseDataLine = {
			type: 'message_delta',
			delta: {
				stop_reason: context.hadToolCalls ? 'tool_use' : 'end_turn',
				stop_sequence: null
			},
			usage: {
				output_tokens: Math.max(context.outputTokens, 1)
			}
		};
		events.push({
			event: messageDelta.type,
			data: JSON.stringify(messageDelta).replace(/\n/g, '\\n')
		});

		const messageStop: MessageStopResponseDataLine = {
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
		const messageStart: MessageStartResponseDataLine = {
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
					service_tier: 'vscode'
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
