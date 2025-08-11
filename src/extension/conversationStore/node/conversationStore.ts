/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { createServiceIdentifier } from '../../../util/common/services';
import { LRUCache } from '../../../util/vs/base/common/map';
import { Conversation, Turn, TurnMessage, TurnStatus, IResultMetadata } from '../../prompt/common/conversation';

export const IConversationStore = createServiceIdentifier<IConversationStore>('IConversationStore');

const CONVERSATION_STORAGE_KEY = 'copilot.conversationStore.conversations';
const MAX_STORED_CONVERSATIONS = 100; // Limit storage size

interface SerializedToolCall {
	name: string;
	arguments: string;
	id: string;
}

interface SerializedToolCallRound {
	id: string;
	summary?: string;
	response: string;
	toolInputRetry: number;
	toolCalls: SerializedToolCall[];
}

interface SerializedCodeBlock {
	code: string;
	language?: string;
	resource?: string; // URI as string
	markdownBeforeBlock?: string;
}

interface SerializedResultMetadata {
	modelMessageId: string;
	responseId: string;
	sessionId: string;
	agentId: string;
	renderedUserMessage?: any[]; // Raw.ChatCompletionContentPart[]
	renderedGlobalContext?: any[]; // Raw.ChatCompletionContentPart[]
	command?: string;
	filterCategory?: any; // FilterReason
	codeBlocks?: SerializedCodeBlock[];
	toolCallRounds?: SerializedToolCallRound[];
	toolCallResults?: Record<string, any>; // Simplified LanguageModelToolResult
	maxToolCallsExceeded?: boolean;
	summary?: { toolCallRoundId: string; text: string };
}

interface SerializedChatResult {
	metadata?: SerializedResultMetadata;
}

interface SerializedTurn {
	id: string;
	request: TurnMessage;
	responseInfo?: {
		message: TurnMessage | undefined;
		status: TurnStatus;
		responseId: string | undefined;
		chatResult?: SerializedChatResult;
	};
	startTime: number;
}

interface SerializedConversation {
	sessionId: string;
	turns: SerializedTurn[];
}

export interface IConversationStore {
	readonly _serviceBrand: undefined;

	addConversation(responseId: string, conversation: Conversation): void;
	getConversation(responseId: string): Conversation | undefined;
	lastConversation: Conversation | undefined;
}

export class ConversationStore implements IConversationStore {
	readonly _serviceBrand: undefined;
	private conversationMap: LRUCache<string, Conversation>;
	private lastAddedConversationId: string | undefined;

	constructor(
		private readonly extensionContext: IVSCodeExtensionContext
	) {
		this.conversationMap = new LRUCache<string, Conversation>(1000);
		this.loadConversations();
	}

	addConversation(responseId: string, conversation: Conversation): void {
		this.conversationMap.set(responseId, conversation);
		this.lastAddedConversationId = responseId;
		this.saveConversations();
	}

	getConversation(responseId: string): Conversation | undefined {
		return this.conversationMap.get(responseId);
	}

	get lastConversation(): Conversation | undefined {
		if (this.lastAddedConversationId) {
			return this.conversationMap.get(this.lastAddedConversationId);
		}
		return this.conversationMap.last;
	}

	private loadConversations(): void {
		try {
			const stored = this.extensionContext.globalState.get<Record<string, SerializedConversation>>(CONVERSATION_STORAGE_KEY, {});

			for (const [responseId, serializedConversation] of Object.entries(stored)) {
				try {
					const conversation = this.deserializeConversation(serializedConversation);
					this.conversationMap.set(responseId, conversation);
				} catch (error) {
					console.error(`Failed to deserialize conversation ${responseId}:`, error);
				}
			}
		} catch (error) {
			console.error('Failed to load conversations from storage:', error);
		}
	}

	private saveConversations(): void {
		try {
			const conversationsToStore: Record<string, SerializedConversation> = {};

			// Get the most recent conversations up to the limit
			const entries = Array.from(this.conversationMap.keys()).slice(-MAX_STORED_CONVERSATIONS);

			for (const responseId of entries) {
				const conversation = this.conversationMap.get(responseId);
				if (conversation) {
					try {
						conversationsToStore[responseId] = this.serializeConversation(conversation);
					} catch (error) {
						console.error(`Failed to serialize conversation ${responseId}:`, error);
					}
				}
			}

			this.extensionContext.globalState.update(CONVERSATION_STORAGE_KEY, conversationsToStore);
		} catch (error) {
			console.error('Failed to save conversations to storage:', error);
		}
	}

	private serializeConversation(conversation: Conversation): SerializedConversation {
		const serializedTurns: SerializedTurn[] = conversation.turns.map(turn => {
			const serializedTurn: SerializedTurn = {
				id: turn.id,
				request: turn.request,
				startTime: turn.startTime
			};

			// Only serialize response info if it exists
			if (turn.responseStatus !== TurnStatus.InProgress || turn.responseMessage || turn.responseId) {
				serializedTurn.responseInfo = {
					message: turn.responseMessage,
					status: turn.responseStatus,
					responseId: turn.responseId,
					chatResult: turn.responseChatResult ? this.serializeChatResult(turn.responseChatResult) : undefined
				};
			}

			return serializedTurn;
		});

		return {
			sessionId: conversation.sessionId,
			turns: serializedTurns
		};
	}

	private serializeChatResult(chatResult: any): SerializedChatResult {
		if (!chatResult.metadata) {
			return {};
		}

		const metadata = chatResult.metadata as Partial<IResultMetadata>;
		const serializedMetadata: SerializedResultMetadata = {
			modelMessageId: metadata.modelMessageId || '',
			responseId: metadata.responseId || '',
			sessionId: metadata.sessionId || '',
			agentId: metadata.agentId || ''
		};

		// Copy simple properties
		if (metadata.renderedUserMessage) {
			serializedMetadata.renderedUserMessage = metadata.renderedUserMessage;
		}
		if (metadata.renderedGlobalContext) {
			serializedMetadata.renderedGlobalContext = metadata.renderedGlobalContext;
		}
		if (metadata.command) {
			serializedMetadata.command = metadata.command;
		}
		if (metadata.filterCategory) {
			serializedMetadata.filterCategory = metadata.filterCategory;
		}
		if (metadata.maxToolCallsExceeded) {
			serializedMetadata.maxToolCallsExceeded = metadata.maxToolCallsExceeded;
		}
		if (metadata.summary) {
			serializedMetadata.summary = metadata.summary;
		}

		// Serialize code blocks
		if (metadata.codeBlocks) {
			serializedMetadata.codeBlocks = metadata.codeBlocks.map(cb => ({
				code: cb.code,
				language: cb.language,
				resource: cb.resource?.toString(),
				markdownBeforeBlock: cb.markdownBeforeBlock
			}));
		}

		// Serialize tool call rounds (this is the key information!)
		if (metadata.toolCallRounds) {
			serializedMetadata.toolCallRounds = metadata.toolCallRounds.map(round => ({
				id: round.id,
				summary: round.summary,
				response: round.response,
				toolInputRetry: round.toolInputRetry,
				toolCalls: round.toolCalls.map(call => ({
					name: call.name,
					arguments: call.arguments,
					id: call.id
				}))
			}));
		}

		// Serialize tool call results (simplified - just preserve the key data)
		if (metadata.toolCallResults) {
			serializedMetadata.toolCallResults = {};
			for (const [callId, result] of Object.entries(metadata.toolCallResults)) {
				try {
					// Simplify the tool result - just preserve it exists
					serializedMetadata.toolCallResults[callId] = {
						_serialized: true,
						content: Array.isArray(result.content) ? result.content.map(part => {
							if (typeof part === 'string') {
								return part;
							}
							if (part && typeof part === 'object' && 'value' in part) {
								return { value: part.value };
							}
							return { _simplified: true };
						}) : []
					};
				} catch (error) {
					console.warn(`Failed to serialize tool result for ${callId}:`, error);
				}
			}
		}

		return { metadata: serializedMetadata };
	}

	private deserializeConversation(serialized: SerializedConversation): Conversation {
		const turns: Turn[] = serialized.turns.map(serializedTurn => {
			// Create a new Turn with minimal data
			const turn = new Turn(
				serializedTurn.id,
				serializedTurn.request,
				undefined, // promptVariables - not persisted for now
				[], // toolReferences - not persisted for now
				undefined // editedFileEvents - not persisted for now
			);

			// Restore the start time
			(turn as any).startTime = serializedTurn.startTime;

			// Restore response info if it exists
			if (serializedTurn.responseInfo) {
				const chatResult = serializedTurn.responseInfo.chatResult ?
					this.deserializeChatResult(serializedTurn.responseInfo.chatResult) : undefined;

				turn.setResponse(
					serializedTurn.responseInfo.status,
					serializedTurn.responseInfo.message,
					serializedTurn.responseInfo.responseId,
					chatResult
				);
			}

			return turn;
		});

		return new Conversation(serialized.sessionId, turns);
	}

	private deserializeChatResult(serialized: SerializedChatResult): any {
		if (!serialized.metadata) {
			return { metadata: {} };
		}

		const metadata = serialized.metadata;
		const deserializedMetadata: Partial<IResultMetadata> = {
			modelMessageId: metadata.modelMessageId,
			responseId: metadata.responseId,
			sessionId: metadata.sessionId,
			agentId: metadata.agentId
		};

		// Restore simple properties
		if (metadata.renderedUserMessage) {
			deserializedMetadata.renderedUserMessage = metadata.renderedUserMessage;
		}
		if (metadata.renderedGlobalContext) {
			deserializedMetadata.renderedGlobalContext = metadata.renderedGlobalContext;
		}
		if (metadata.command) {
			deserializedMetadata.command = metadata.command;
		}
		if (metadata.filterCategory) {
			deserializedMetadata.filterCategory = metadata.filterCategory;
		}
		if (metadata.maxToolCallsExceeded) {
			deserializedMetadata.maxToolCallsExceeded = metadata.maxToolCallsExceeded;
		}
		if (metadata.summary) {
			deserializedMetadata.summary = metadata.summary;
		}

		// Restore code blocks
		if (metadata.codeBlocks) {
			deserializedMetadata.codeBlocks = metadata.codeBlocks.map(cb => ({
				code: cb.code,
				language: cb.language,
				resource: cb.resource ? { toString: () => cb.resource } as any : undefined,
				markdownBeforeBlock: cb.markdownBeforeBlock
			}));
		}

		// Restore tool call rounds (the most important part!)
		if (metadata.toolCallRounds) {
			deserializedMetadata.toolCallRounds = metadata.toolCallRounds.map(round => ({
				id: round.id,
				summary: round.summary,
				response: round.response,
				toolInputRetry: round.toolInputRetry,
				toolCalls: round.toolCalls.map(call => ({
					name: call.name,
					arguments: call.arguments,
					id: call.id
				}))
			}));
		}

		// Restore tool call results (simplified)
		if (metadata.toolCallResults) {
			deserializedMetadata.toolCallResults = {};
			for (const [callId, result] of Object.entries(metadata.toolCallResults)) {
				try {
					// Create a simplified tool result that looks like a LanguageModelToolResult
					deserializedMetadata.toolCallResults[callId] = {
						content: result.content || [],
						_restored: true
					} as any;
				} catch (error) {
					console.warn(`Failed to deserialize tool result for ${callId}:`, error);
				}
			}
		}

		return { metadata: deserializedMetadata };
	}
}
