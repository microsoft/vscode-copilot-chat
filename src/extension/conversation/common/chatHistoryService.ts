/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';

export interface ChatHistoryItem {
	text: string;
	timestamp: number;
}

// Interface for conversation store - avoiding import restriction
export interface IConversationStore {
	readonly _serviceBrand: undefined;
	getAllConversations(): any[];
}

export const IConversationStoreToken = createDecorator<IConversationStore>('conversationStore');

export const IChatHistoryService = createDecorator<IChatHistoryService>('chatHistoryService');

export interface IChatHistoryService {
	readonly _serviceBrand: undefined;

	getHistory(): ChatHistoryItem[];
	searchHistory(query: string): ChatHistoryItem[];
	addToHistory(text: string): void;
	clearHistory(): void;
	clearAllStoredData(): Promise<void>;
	syncWithVSCodeHistory(chatHistory: readonly vscode.ChatRequestTurn[]): void;
	loadInitialHistory(): Promise<void>;

	readonly onDidChangeHistory: Event<void>;
}

// Simple LRU implementation for history management
class LRUCache<T> {
	private items: Map<string, T> = new Map();

	constructor(private maxSize: number) { }

	set(key: string, value: T): void {
		if (this.items.has(key)) {
			this.items.delete(key);
		} else if (this.items.size >= this.maxSize) {
			const firstKey = this.items.keys().next().value;
			if (firstKey !== undefined) {
				this.items.delete(firstKey);
			}
		}
		this.items.set(key, value);
	}

	has(key: string): boolean {
		return this.items.has(key);
	}

	values(): T[] {
		return Array.from(this.items.values());
	}

	clear(): void {
		this.items.clear();
	}
}

export class ChatHistoryService extends Disposable implements IChatHistoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeHistory = new Emitter<void>();
	readonly onDidChangeHistory: Event<void> = this._onDidChangeHistory.event;

	private historyCache = new LRUCache<ChatHistoryItem>(10000); // Much larger limit (10k)
	private static readonly STORAGE_KEY = 'github.copilot.chat.history';
	private static extensionContext: vscode.ExtensionContext | undefined;

	constructor(
		@IConversationStoreToken private readonly conversationStore: IConversationStore
	) {
		super();
		this._register(this._onDidChangeHistory);

		// Load persisted history in constructor
		this.loadPersistedHistory();

		// Load initial data from ConversationStore asynchronously
		this.loadInitialHistory().catch(error => {
			// Handle errors silently
		});
	}

	static setExtensionContext(context: vscode.ExtensionContext): void {
		ChatHistoryService.extensionContext = context;
	}

	private loadPersistedHistory(): void {
		if (!ChatHistoryService.extensionContext) {
			return;
		}

		try {
			const storedHistory = ChatHistoryService.extensionContext.globalState.get<ChatHistoryItem[]>(ChatHistoryService.STORAGE_KEY, []);

			// Load history only if cache is empty - prevent duplicate loading
			if (this.historyCache.values().length === 0) {
				storedHistory.forEach((item: ChatHistoryItem) => {
					if (item.text && typeof item.timestamp === 'number') {
						// Create stable key - not random, based on text+timestamp
						const stableKey = `${item.text}|${item.timestamp}`;
						this.historyCache.set(stableKey, item);
					}
				});
			}
		} catch (error) {
			// Handle errors silently
		}
	}

	private persistHistory(): void {
		if (!ChatHistoryService.extensionContext) {
			return;
		}

		try {
			const historyToStore = this.getHistory(); // Store entire history, no limit
			ChatHistoryService.extensionContext.globalState.update(ChatHistoryService.STORAGE_KEY, historyToStore);
		} catch (error) {
			// Silently ignore storage errors
		}
	}

	getHistory(): ChatHistoryItem[] {
		return this.historyCache.values().sort((a, b) => b.timestamp - a.timestamp); // Most recent first
	}

	searchHistory(query: string): ChatHistoryItem[] {
		if (!query.trim()) {
			return this.getHistory();
		}

		const normalizedQuery = query.toLowerCase();
		return this.getHistory().filter(item =>
			item.text.toLowerCase().includes(normalizedQuery)
		);
	}

	addToHistory(text: string): void {
		if (!text.trim()) {
			return;
		}

		// Set timestamp in addToHistoryInternal, not here
		this.addToHistoryInternal(text);
		this._onDidChangeHistory.fire();
		this.persistHistory(); // Persist after adding
	}

	private addToHistoryInternal(text: string, timestamp?: number): void {
		const trimmedText = text.trim();
		if (!trimmedText) {
			return;
		}

		const actualTimestamp = timestamp || Date.now();
		const item: ChatHistoryItem = {
			text: trimmedText,
			timestamp: actualTimestamp
		};

		// Use text as key for simplicity (duplicates already prevented above)
		const stableKey = `${trimmedText}|${actualTimestamp}`;
		this.historyCache.set(stableKey, item);
	}

	async loadInitialHistory(): Promise<void> {
		// Try to get conversation history from ConversationStore
		try {
			const allConversations = this.conversationStore.getAllConversations();

			if (allConversations?.length > 0) {
				// Add user inputs from all conversations to history
				allConversations.forEach((conversation: any) => {
					if (conversation.turns) {
						conversation.turns.forEach((turn: any) => {
							// Get user type messages
							if (turn.request?.type === 'user' && turn.request?.message && typeof turn.request.message === 'string') {
								this.addToHistoryInternal(turn.request.message, turn.startTime || Date.now());
							}
						});
					}
				});
			}
		} catch (error) {
			// Handle errors silently
		}

		// Notify changes and persist
		if (this.getHistory().length > 0) {
			this._onDidChangeHistory.fire();
			this.persistHistory();
		}
	}

	clearHistory(): void {
		this.historyCache.clear();
		this._onDidChangeHistory.fire();
		this.persistHistory(); // Also clear persistent storage
	}

	// Utility method to clear all stored data (including test data)
	async clearAllStoredData(): Promise<void> {
		if (ChatHistoryService.extensionContext) {
			await ChatHistoryService.extensionContext.globalState.update(ChatHistoryService.STORAGE_KEY, undefined);
			this.historyCache.clear();
			this._onDidChangeHistory.fire();
		}
	}

	syncWithVSCodeHistory(chatHistory: readonly vscode.ChatRequestTurn[]): void {
		if (!chatHistory?.length) {
			return;
		}

		// Get existing history to avoid duplicates
		const existingHistory = this.getHistory();
		let addedCount = 0;

		// Add VS Code chat history items to our cache with their actual timestamps
		chatHistory.forEach((turn, index) => {
			if (turn.prompt) {
				// Try to get real timestamp from VS Code turn, fallback to approximation
				let timestamp: number;

				// Check if turn has timestamp property
				if ('timestamp' in turn && typeof turn.timestamp === 'number') {
					timestamp = turn.timestamp;
				} else if ('createdAt' in turn && turn.createdAt instanceof Date) {
					timestamp = turn.createdAt.getTime();
				} else {
					// Fallback: approximate based on reverse order (oldest first approach)
					// Assume 5 minutes between each historical message
					timestamp = Date.now() - (chatHistory.length - index) * 5 * 60 * 1000;
				}

				// Check if this exact text already exists (ignore timestamp for basic deduplication)
				const isDuplicate = existingHistory.some(existing => existing.text === turn.prompt);

				if (!isDuplicate) {
					this.addToHistoryInternal(turn.prompt, timestamp);
					addedCount++;
				}
			}
		});

		// Only fire event and persist if we actually added something new
		if (addedCount > 0) {
			this._onDidChangeHistory.fire();
			this.persistHistory(); // Persist after syncing
		}
	}
}
