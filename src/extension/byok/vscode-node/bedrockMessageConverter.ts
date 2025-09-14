/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import {
    CachePoint,
    ContentBlock,
    Message as BedrockMessage,
    SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
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
            let cachePoint: CachePoint | undefined;
            const content: ContentBlock[] = message.content
                .map(p => {
                    if (p instanceof LanguageModelTextPart) {
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
                                inputText: JSON.stringify(p.input ?? {}),
                            },
                        } as ContentBlock;
                    }
                    if (
                        p instanceof LanguageModelDataPart &&
                        p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                        p.data.toString() === 'ephemeral'
                    ) {
                        cachePoint = { type: 'ephemeral' };
                    }
                    return undefined;
                })
                .filter((c): c is ContentBlock => !!c);
            convertedMessages.push({ role: 'assistant', content, cachePoint });
        } else if (message.role === LanguageModelChatMessageRole.User) {
            let cachePoint: CachePoint | undefined;
            const content: ContentBlock[] = message.content
                .map(p => {
                    if (p instanceof LanguageModelTextPart) {
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
                                        if (part instanceof LanguageModelTextPart) {
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
                        p.data.toString() === 'ephemeral'
                    ) {
                        cachePoint = { type: 'ephemeral' };
                    }
                    return undefined;
                })
                .filter((c): c is ContentBlock => !!c);
            convertedMessages.push({ role: 'user', content, cachePoint });
        } else {
            // system or other roles
            let text = '';
            let cachePoint: CachePoint | undefined;
            for (const p of message.content) {
                if (p instanceof LanguageModelTextPart) {
                    text += p.value;
                } else if (
                    p instanceof LanguageModelDataPart &&
                    p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                    p.data.toString() === 'ephemeral'
                ) {
                    cachePoint = { type: 'ephemeral' };
                }
            }
            if (!system) {
                system = [];
            }
            system.push({ text, cachePoint });
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
                    { type: Raw.ChatCompletionContentPartKind.Text, text: s.text },
                ];
                if (s.cachePoint) {
                    parts.push({
                        type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
                        cacheType: s.cachePoint.type,
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
            ...message.content.map(c => {
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
                if ('toolUse' in c) {
                    if (!toolCalls) {
                        toolCalls = [];
                    }
                    toolCalls.push({
                        id: c.toolUse.toolUseId,
                        type: 'function',
                        function: {
                            name: c.toolUse.name,
                            arguments: c.toolUse.inputText,
                        },
                    });
                    return undefined;
                }
                if ('toolResult' in c) {
                    toolCallId = c.toolResult.toolUseId;
                    return undefined;
                }
                return undefined;
            }),
            message.cachePoint
                ? [
                      {
                          type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
                          cacheType: message.cachePoint.type,
                      } as Raw.ChatCompletionContentPart,
                  ]
                : [],
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
