/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Message as BedrockMessage,
	CachePointBlock,
	CachePointType,
	ContentBlock,
	SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { Raw } from '@vscode/prompt-tsx';
import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelDataPart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelToolResultPart2,
} from 'vscode';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { coalesce } from '../../../util/vs/base/common/arrays';

export function apiMessageToBedrockMessage(messages: LanguageModelChatMessage[]): {
	messages: BedrockMessage[];
	system?: SystemContentBlock[];
} {
	const convertedMessages: BedrockMessage[] = [];
	let system: SystemContentBlock[] | undefined;

	for (const message of messages) {
		if (message.role === LanguageModelChatMessageRole.Assistant) {
			let cachePoint: CachePointBlock | undefined;
			const content: ContentBlock[] = (message.content || [])
				.map(p => {
					if (p instanceof LanguageModelTextPart && p.value) {
						return { text: p.value } as ContentBlock;
					}
					if (p instanceof LanguageModelDataPart && p.mimeType.startsWith('image/')) {
						return {
							image: {
								format: p.mimeType.substring('image/'.length),
								source: { bytes: p.data },
							},
						} as ContentBlock;
					}
					if (p instanceof LanguageModelToolCallPart) {
						return {
							toolUse: {
								toolUseId: p.callId,
								name: p.name,
								input: p.input ?? {},
							},
						} as ContentBlock;
					}
					if (
						p instanceof LanguageModelDataPart &&
						p.mimeType === CustomDataPartMimeTypes.CacheControl &&
						p.data.toString() === 'ephemeral'
					) {
						cachePoint = { type: CachePointType.DEFAULT };
					}
					return undefined;
				})
				.filter((c): c is ContentBlock => !!c);
			const bedrockMessage: BedrockMessage = { role: 'assistant', content };
			if (cachePoint) {
				(bedrockMessage as any).cachePoint = cachePoint;
			}
			convertedMessages.push(bedrockMessage);
		} else if (message.role === LanguageModelChatMessageRole.User) {
			let cachePoint: CachePointBlock | undefined;
			const content: ContentBlock[] = (message.content || [])
				.map(p => {
					if (p instanceof LanguageModelTextPart && p) {
						return { text: p.value } as ContentBlock;
					}
					if (p instanceof LanguageModelDataPart && p.mimeType.startsWith('image/')) {
						return {
							image: {
								format: p.mimeType.substring('image/'.length),
								source: { bytes: p.data },
							},
						} as ContentBlock;
					}
					if (
						p instanceof LanguageModelToolResultPart ||
						p instanceof LanguageModelToolResultPart2
					) {
						return {
							toolResult: {
								toolUseId: p.callId,
								content: p.content
									.map(part => {
										if (part instanceof LanguageModelTextPart && part.value) {
											return { text: part.value } as ContentBlock;
										}
										if (
											part instanceof LanguageModelDataPart &&
											part.mimeType.startsWith('image/')
										) {
											return {
												image: {
													format: part.mimeType.substring('image/'.length),
													source: { bytes: part.data },
												},
											} as ContentBlock;
										}
										return undefined;
									})
									.filter((c): c is ContentBlock => !!c),
								status: 'success',
							},
						} as ContentBlock;
					}
					if (
						p instanceof LanguageModelDataPart &&
						p.mimeType === CustomDataPartMimeTypes.CacheControl &&
						p.data.toString() === CachePointType.DEFAULT
					) {
						cachePoint = { type: CachePointType.DEFAULT };
					}
					return undefined;
				})
				.filter((c): c is ContentBlock => !!c);
			const bedrockMessage: BedrockMessage = { role: 'user', content };
			if (cachePoint) {
				(bedrockMessage as any).cachePoint = cachePoint;
			}
			convertedMessages.push(bedrockMessage);
		} else {
			// system or other roles
			let text = '';
			let cachePoint: CachePointBlock | undefined;
			for (const p of message.content) {
				if (p instanceof LanguageModelTextPart && p) {
					text += p.value;
				} else if (
					p instanceof LanguageModelDataPart &&
					p.mimeType === CustomDataPartMimeTypes.CacheControl &&
					p.data.toString() === CachePointType.DEFAULT
				) {
					cachePoint = { type: CachePointType.DEFAULT };
				}
			}
			if (!system) {
				system = [];
			}
			const systemBlock: SystemContentBlock = { text };
			if (cachePoint) {
				(systemBlock as any).cachePoint = cachePoint;
			}
			system.push(systemBlock);
		}
	}

	return { messages: convertedMessages, system };
}

export function bedrockMessagesToRawMessagesForLogging(messages: BedrockMessage[], system?: SystemContentBlock[]): Raw.ChatMessage[] {
	const rawMessages: Raw.ChatMessage[] = [];
	if (system && system.length > 0) {
		rawMessages.push({
			role: Raw.ChatRole.System,
			content: system.flatMap(s => {
				const parts: Raw.ChatCompletionContentPart[] = [
					{ type: Raw.ChatCompletionContentPartKind.Text, text: s.text || '' },
				];
				const cachePoint = (s as any).cachePoint;
				if (cachePoint) {
					parts.push({
						type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
						cacheType: cachePoint.type,
					});
				}
				return parts;
			}),
		});
	}
	for (const message of messages) {
		let content: Raw.ChatCompletionContentPart[] = [];
		let toolCalls: Raw.ChatMessageToolCall[] | undefined;
		let toolCallId: string | undefined;

		content = coalesce([
			...(message.content || []).map(c => {
				if ('text' in c) {
					return {
						type: Raw.ChatCompletionContentPartKind.Text,
						text: c.text,
					} as Raw.ChatCompletionContentPart;
				}
				if ('image' in c) {
					return {
						type: Raw.ChatCompletionContentPartKind.Image,
						imageUrl: { url: '(image)' },
					} as Raw.ChatCompletionContentPart;
				}
				if ('toolUse' in c && c.toolUse) {
					if (!toolCalls) {
						toolCalls = [];
					}
					toolCalls.push({
						id: c.toolUse.toolUseId || '',
						type: 'function' as const,
						function: {
							name: c.toolUse.name || '',
							arguments: JSON.stringify(c.toolUse.input || {}),
						},
					});
					return undefined;
				}
				if ('toolResult' in c && c.toolResult) {
					toolCallId = c.toolResult.toolUseId || '';
					return undefined;
				}
				return undefined;
			}),
			...((message as any).cachePoint
				? [
					{
						type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
						cacheType: (message as any).cachePoint.type,
					} as Raw.ChatCompletionContentPart,
				]
				: []),
		]);

		if (message.role === 'assistant') {
			const msg: Raw.AssistantChatMessage = { role: Raw.ChatRole.Assistant, content };
			if (toolCalls && toolCalls.length > 0) {
				msg.toolCalls = toolCalls;
			}
			rawMessages.push(msg);
		} else {
			if (toolCallId) {
				rawMessages.push({
					role: Raw.ChatRole.Tool,
					content: [
						{ type: Raw.ChatCompletionContentPartKind.Text, text: '(tool result)' },
					],
					toolCallId,
				});
			} else {
				rawMessages.push({ role: Raw.ChatRole.User, content });
			}
		}
	}
	return rawMessages;
}
