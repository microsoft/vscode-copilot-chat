/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IMemoryService } from '../../memory/common/memoryService';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation } from './toolUtils';

interface IMemoryToolParams {
	action: 'store' | 'search' | 'list' | 'delete' | 'storeConversation';
	content?: string;
	query?: string;
	tags?: string[];
	memoryId?: string;
	maxResults?: number;
	conversationSummary?: string;
	conversationContext?: string;
}

class MemoryTool implements vscode.LanguageModelTool<IMemoryToolParams> {
	public static readonly toolName = ToolName.Memory;

	constructor(
		@IMemoryService private readonly memoryService: IMemoryService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IMemoryToolParams>, token: vscode.CancellationToken) {
		const { action, content, query, tags, memoryId, maxResults = 10, conversationSummary, conversationContext } = options.input;

		checkCancellation(token);

		switch (action) {
			case 'store': {
				if (!content) {
					throw new Error('Content is required for storing memory');
				}

				const memory = await this.memoryService.storeMemory({
					content,
					tags: tags || [],
					timestamp: new Date(),
					source: 'user-input'
				});

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Memory stored successfully with ID: ${memory.id}`)
				]);
			}

			case 'search': {
				if (!query) {
					throw new Error('Query is required for searching memory');
				}

				const results = await this.memoryService.searchMemories(query, {
					maxResults,
					tags,
					semanticSearch: true
				});

				const resultText = results.length > 0
					? results.map((r, i) =>
						`${i + 1}. [${r.similarity.toFixed(3)}] ${r.memory.content.substring(0, 200)}${r.memory.content.length > 200 ? '...' : ''} (Tags: ${r.memory.tags.join(', ') || 'none'})`
					).join('\n\n')
					: 'No matching memories found.';

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Found ${results.length} memory results:\n\n${resultText}`)
				]);
			}

			case 'list': {
				const memories = await this.memoryService.listMemories({
					tags,
					limit: maxResults
				});

				const listText = memories.length > 0
					? memories.map((m, i) =>
						`${i + 1}. ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''} (${m.timestamp.toLocaleDateString()})`
					).join('\n')
					: 'No memories found.';

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Memory list (${memories.length} items):\n\n${listText}`)
				]);
			}

			case 'delete': {
				if (!memoryId) {
					throw new Error('Memory ID is required for deletion');
				}

				await this.memoryService.deleteMemory(memoryId);

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Memory with ID ${memoryId} deleted successfully`)
				]);
			}

			case 'storeConversation': {
				if (!conversationSummary && !conversationContext) {
					throw new Error('Conversation summary or context is required for storing conversation');
				}

				const memory = await this.memoryService.storeMemory({
					content: conversationSummary || conversationContext || '',
					tags: [...(tags || []), 'conversation', 'context'],
					timestamp: new Date(),
					source: 'conversation-summary'
				});

				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Conversation context stored successfully with ID: ${memory.id}`)
				]);
			}

			default:
				throw new Error(`Unknown action: ${action}`);
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IMemoryToolParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const action = options.input.action;
		const actionMessages = {
			store: 'Storing memory...',
			search: 'Searching memories...',
			list: 'Listing memories...',
			delete: 'Deleting memory...',
			storeConversation: 'Storing conversation context...'
		};

		return {
			invocationMessage: actionMessages[action] || 'Processing memory request...'
		};
	}
}

ToolRegistry.registerTool(MemoryTool);