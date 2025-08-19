/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ContentBlockParam, ImageBlockParam, MessageParam, RedactedThinkingBlockParam, TextBlockParam, ThinkingBlockParam } from '@anthropic-ai/sdk/resources';
import { Raw } from '@vscode/prompt-tsx';
import { LanguageModelChatMessage, LanguageModelChatMessageRole, LanguageModelDataPart, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelToolResultPart2 } from 'vscode';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { isDefined } from '../../../util/vs/base/common/types';

function apiContentToAnthropicContent(content: (LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart)[]): ContentBlockParam[] {
	const convertedContent: ContentBlockParam[] = [];
	for (const part of content) {
		if (part instanceof LanguageModelToolCallPart) {
			convertedContent.push({
				type: 'tool_use',
				id: part.callId,
				input: part.input,
				name: part.name,
			});
		} else if (part instanceof LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.CacheControl && part.data.toString() === 'ephemeral') {
			const previousBlock = convertedContent.at(-1);
			if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
				previousBlock.cache_control = { type: 'ephemeral' };
			} else {
				// Empty string is invalid
				convertedContent.push({
					type: 'text',
					text: ' ',
					cache_control: { type: 'ephemeral' }
				});
			}
		} else if (part instanceof LanguageModelDataPart) {
			convertedContent.push({
				type: 'image',
				source: {
					type: 'base64',
					data: Buffer.from(part.data).toString('base64'),
					media_type: part.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp"
				}
			});
		} else if (part instanceof LanguageModelToolResultPart || part instanceof LanguageModelToolResultPart2) {
			convertedContent.push({
				type: 'tool_result',
				tool_use_id: part.callId,
				content: part.content.map((p): TextBlockParam | ImageBlockParam | undefined => {
					if (p instanceof LanguageModelTextPart) {
						return { type: 'text', text: p.value };
					} else if (p instanceof LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.CacheControl && p.data.toString() === 'ephemeral') {
						// Empty string is invalid
						return { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } };
					} else if (p instanceof LanguageModelDataPart) {
						return { type: 'image', source: { type: 'base64', media_type: p.mimeType as any, data: Buffer.from(p.data).toString('base64') } };
					}
				}).filter(isDefined),
			});
		} else {
			// Anthropic errors if we have text parts with empty string text content
			if (part.value === '') {
				continue;
			}
			convertedContent.push({
				type: 'text',
				text: part.value
			});
		}
	}
	return convertedContent;

}

export function apiMessageToAnthropicMessage(messages: LanguageModelChatMessage[]): { messages: MessageParam[]; system: TextBlockParam } {
	const unmergedMessages: MessageParam[] = [];
	const systemMessage: TextBlockParam = {
		type: 'text',
		text: ''
	};
	for (const message of messages) {
		if (message.role === LanguageModelChatMessageRole.Assistant) {
			unmergedMessages.push({
				role: 'assistant',
				content: apiContentToAnthropicContent(message.content),
			});
		} else if (message.role === LanguageModelChatMessageRole.User) {
			unmergedMessages.push({
				role: 'user',
				content: apiContentToAnthropicContent(message.content),
			});
		} else {
			systemMessage.text += message.content.map(p => {
				// For some reason instance of doesn't work
				if (p instanceof LanguageModelTextPart) {
					return p.value;
				} else if (p instanceof LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.CacheControl && p.data.toString() === 'ephemeral') {
					systemMessage.cache_control = { type: 'ephemeral' };
				}
				return '';
			}).join('');
		}
	}

	// Merge messages of the same type that are adjacent together, this is what anthropic expects
	const mergedMessages: MessageParam[] = [];
	for (const message of unmergedMessages) {
		if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== message.role) {
			mergedMessages.push(message);
		} else {
			// Merge with the previous message of the same role
			const prevMessage = mergedMessages[mergedMessages.length - 1];
			// Concat the content arrays if they're both arrays - They always will be due to the way apiContentToAnthropicContent works
			if (Array.isArray(prevMessage.content) && Array.isArray(message.content)) {
				(prevMessage.content as ContentBlockParam[]).push(...(message.content as ContentBlockParam[]));
			}
		}
	}

	return { messages: mergedMessages, system: systemMessage };
}

function contentBlockSupportsCacheControl(block: ContentBlockParam): block is Exclude<ContentBlockParam, | ThinkingBlockParam | RedactedThinkingBlockParam> {
	return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

export function anthropicMessagesToRawMessagesForLogging(messages: MessageParam[], system: TextBlockParam): Raw.ChatMessage[] {
	const rawMessages: Raw.ChatMessage[] = [];

	if (system) {
		const systemContent: Raw.ChatCompletionContentPart[] = [{
			type: Raw.ChatCompletionContentPartKind.Text,
			text: system.text,
		}];
		if (system.cache_control) {
			systemContent.push({
				type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
				cacheType: system.cache_control.type
			});
		}
		rawMessages.push({
			role: Raw.ChatRole.System,
			content: systemContent,
		});
	}

	for (const message of messages) {
		let content: Raw.ChatCompletionContentPart[] = [];
		let toolCalls: Raw.ChatMessageToolCall[] | undefined;
		let toolCallId: string | undefined;

		if (Array.isArray(message.content)) {
			content = coalesce(message.content.flatMap(block => {
				let cachePart: Raw.ChatCompletionContentPartCacheBreakpoint | undefined;
				if (contentBlockSupportsCacheControl(block) && block.cache_control) {
					cachePart = {
						type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
						cacheType: block.cache_control.type
					};
				}

				let contentPart: Raw.ChatCompletionContentPart | undefined;
				if (block.type === 'text') {
					contentPart = {
						type: Raw.ChatCompletionContentPartKind.Text,
						text: block.text
					};
				} else if (block.type === 'image') {
					contentPart = {
						type: Raw.ChatCompletionContentPartKind.Image,
						imageUrl: {
							url: '(image)'
						}
					};
				} else if (block.type === 'tool_use') {
					if (!toolCalls) {
						toolCalls = [];
					}
					toolCalls.push({
						id: block.id,
						type: 'function',
						function: {
							name: block.name,
							arguments: JSON.stringify(block.input)
						}
					});
					return undefined;
				} else if (block.type === 'tool_result') {
					toolCallId = block.tool_use_id;
					// TODO Convert block.content
					return undefined;
				}

				return [contentPart, cachePart];
			}));
		} else if (typeof message.content === 'string') {
			content = [{
				type: Raw.ChatCompletionContentPartKind.Text,
				text: message.content
			}];
		}

		if (message.role === 'assistant') {
			const msg: Raw.AssistantChatMessage = { role: Raw.ChatRole.Assistant, content };
			if (toolCalls && toolCalls.length > 0) {
				msg.toolCalls = toolCalls;
			}
			rawMessages.push(msg);
		} else if (message.role === 'user') {
			if (toolCallId) {
				rawMessages.push({ role: Raw.ChatRole.Tool, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: '(tool result)' }], toolCallId });
			} else {
				rawMessages.push({ role: Raw.ChatRole.User, content });
			}
		}
	}

	return rawMessages;
}

export function anthropicMessageParamsToApiMessages(message: MessageParam): LanguageModelChatMessage[] {
	const vscodeMessages: LanguageModelChatMessage[] = [];
	const pendingTextParts: LanguageModelTextPart[] = [];

	const flushText = () => {
		if (pendingTextParts.length === 0) { return; }
		if (message.role === 'user') {
			vscodeMessages.push(LanguageModelChatMessage.User([...pendingTextParts]));
		} else if (message.role === 'assistant') {
			vscodeMessages.push(LanguageModelChatMessage.Assistant([...pendingTextParts]));
		}
		pendingTextParts.length = 0;
	};

	if (typeof message.content === 'string') {
		if (message.role === 'user') {
			vscodeMessages.push(LanguageModelChatMessage.User(message.content));
		} else if (message.role === 'assistant') {
			vscodeMessages.push(LanguageModelChatMessage.Assistant(message.content));
		}
		return vscodeMessages;
	}

	// TODO - some Anthropic content types aren't supported in the LM API
	for (const block of message.content) {
		if (message.role === 'user') {
			if (block.type === 'text') {
				pendingTextParts.push(new LanguageModelTextPart(block.text));
			} else if (block.type === 'tool_result') {
				// Break around tool result blocks
				flushText();
				const parts: (LanguageModelTextPart | LanguageModelDataPart)[] = [];
				for (const c of block.content ?? []) {
					if (typeof c === 'string') {
						parts.push(new LanguageModelTextPart(c));
					} else if (c.type === 'text') {
						parts.push(new LanguageModelTextPart(c.text));
					} else if (c.type === 'image' && c.source.type === 'base64') {
						parts.push(new LanguageModelDataPart(Buffer.from(c.source.data, 'base64'), c.source.media_type));
					} else if (c.type === 'image' && c.source.type === 'url') {
						// Not supported
					}
				}
				vscodeMessages.push(LanguageModelChatMessage.User([
					new LanguageModelToolResultPart2(block.tool_use_id, parts)
				]));
			}
			// Ignore other block types (e.g., images, thinking, cache control)
		} else if (message.role === 'assistant') {
			if (block.type === 'text') {
				pendingTextParts.push(new LanguageModelTextPart(block.text));
			} else if (block.type === 'tool_use') {
				// Break around tool use blocks
				flushText();
				vscodeMessages.push(LanguageModelChatMessage.Assistant([
					new LanguageModelToolCallPart(block.id, block.name, block.input ?? {})
				]));
			}
		}
	}

	// Flush any remaining text as a single message
	flushText();

	return vscodeMessages;
}