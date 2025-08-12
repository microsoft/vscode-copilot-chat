/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart } from '../../../vscodeTypes';
import { IConversationStore } from '../../conversationStore/node/conversationStore';

/**
 * Registers chat export commands with VS Code.
 * - 'github.copilot.chat.exportChat': Exports all conversations to a single file
 */
export function registerExportChatCommands(accessor: ServicesAccessor): IDisposable {
	const conversationStore = accessor.get(IConversationStore);
	const logService = accessor.get(ILogService);
	const telemetryService = accessor.get(ITelemetryService);

	const disposables = new DisposableStore();

	// Register the export all chats command
	disposables.add(vscode.commands.registerCommand('github.copilot.chat.exportChat', async () => {
		try {
			await exportAllChats(conversationStore, logService, telemetryService);
		} catch (error) {
			logService.error('Error exporting chats:', error);
			vscode.window.showErrorMessage(l10n.t('Failed to export chats: {0}', error instanceof Error ? error.message : String(error)));
		}
	}));

	return disposables;
}

/**
 * Exports all chat conversations to a single markdown file.
 */
async function exportAllChats(
	conversationStore: IConversationStore,
	logService: ILogService,
	telemetryService: ITelemetryService
): Promise<void> {
	// Get all available conversations
	const allConversations = conversationStore.getAllConversations();

	if (allConversations.length === 0) {
		vscode.window.showInformationMessage(l10n.t('No chat conversations found to export.'));
		return;
	}

	// Build the combined content for all conversations
	const chatContent = buildAllChatsExportContent(allConversations);

	if (!chatContent.trim()) {
		vscode.window.showInformationMessage(l10n.t('No chat content found to export.'));
		return;
	}

	// Create filename with timestamp and conversation count
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
	const filename = `copilot-all-chats-${allConversations.length}conversations-${timestamp}.md`;

	// Show save dialog
	const saveOptions: vscode.SaveDialogOptions = {
		defaultUri: vscode.Uri.file(filename),
		filters: {
			'Markdown': ['md'],
			'Text': ['txt']
		},
		saveLabel: l10n.t('Export All Chats')
	};

	const uri = await vscode.window.showSaveDialog(saveOptions);

	if (!uri) {
		// User cancelled
		return;
	}

	// Write the content to the file
	const encoder = new TextEncoder();
	const data = encoder.encode(chatContent);

	await vscode.workspace.fs.writeFile(uri, data);

	// Show success message with option to open the file
	const openChoice = l10n.t('Open File');
	const choice = await vscode.window.showInformationMessage(
		l10n.t('All chats exported successfully to {0}', uri.fsPath),
		openChoice
	);

	if (choice === openChoice) {
		await vscode.window.showTextDocument(uri);
	}

	// Send telemetry
	const totalTurns = allConversations.reduce((sum, item) => sum + item.conversation.turns.length, 0);
	telemetryService.sendMSFTTelemetryEvent('exportAllChats', {
		success: 'true',
		conversationsCount: allConversations.length.toString(),
		totalTurns: totalTurns.toString()
	});

	logService.info(`All chats exported successfully to: ${uri.fsPath}`);
}

/**
 * Helper function to render a user request section
 */
function renderRequest(request: any): string[] {
	const lines: string[] = [];

	if (request) {
		lines.push('### User Request');
		lines.push('');
		lines.push('```');
		lines.push(request.message || 'No message');
		lines.push('```');
		lines.push('');

		// Add any variables or context
		if (request.variables) {
			lines.push('**Context Variables:**');
			for (const variable of request.variables) {
				lines.push(`- **${variable.name}:** ${variable.value || 'N/A'}`);
			}
			lines.push('');
		}
	}

	return lines;
}

/**
 * Helper function to render an assistant response section
 */
function renderResponse(responseMessage: any, response: any): string[] {
	const lines: string[] = [];

	if (responseMessage || response) {
		lines.push('### Assistant Response');
		lines.push('');

		// Handle different response formats
		let responseContent = '';

		if (responseMessage?.message) {
			responseContent = responseMessage.message;
		} else if (response) {
			// Handle response parts (like ChatResponseMarkdownPart)
			if (Array.isArray(response)) {
				responseContent = response.map((part: any) => {
					if (part instanceof ChatResponseMarkdownPart) {
						return part.value.value;
					} else if (typeof part === 'string') {
						return part;
					} else if (part && typeof part === 'object' && 'content' in part) {
						return part.content;
					}
					return String(part);
				}).join('\n');
			} else {
				responseContent = String(response);
			}
		}

		lines.push(responseContent || 'No response content');
		lines.push('');
	}

	return lines;
}

/**
 * Helper function to render tool calls section
 */
function renderToolCalls(toolCallRounds: any[]): string[] {
	const lines: string[] = [];

	if (toolCallRounds && toolCallRounds.length > 0) {
		lines.push('### Tool Calls');
		lines.push('');

		for (const toolRound of toolCallRounds) {
			if (toolRound.toolCalls) {
				for (const toolCall of toolRound.toolCalls) {
					lines.push(`**Tool:** ${toolCall.name || 'Unknown'}`);
					if (toolCall.input) {
						lines.push('```json');
						lines.push(JSON.stringify(toolCall.input, null, 2));
						lines.push('```');
					}
					lines.push('');
				}
			}
		}
	}

	return lines;
}

/**
 * Helper function to render a complete turn with all its components
 */
function renderTurn(turn: any, turnIndex: number): string[] {
	const lines: string[] = [];

	// Add turn separator
	lines.push(`## Turn ${turnIndex + 1}`);
	lines.push('');

	// Add turn timestamp if available
	if (turn.startTime) {
		lines.push(`*${new Date(turn.startTime).toLocaleString()}*`);
		lines.push('');
	}

	// Add user request
	lines.push(...renderRequest(turn.request));

	// Add assistant response
	lines.push(...renderResponse(turn.responseMessage, turn.response));

	// Add tool call information if available
	lines.push(...renderToolCalls(turn.resultMetadata?.toolCallRounds));

	return lines;
}

/**
 * Helper function to render conversation metadata
 */
function renderConversationHeader(conversation: any, responseId: string, conversationIndex: number): string[] {
	const lines: string[] = [];

	// Add conversation header
	lines.push(`# Conversation ${conversationIndex + 1}`);
	lines.push('');
	lines.push(`**Conversation ID:** ${conversation.id || conversation.sessionId || responseId}`);
	lines.push(`**Response ID:** ${responseId}`);
	lines.push(`**Turns:** ${conversation.turns?.length || 0}`);

	// Add session start time if available
	if (conversation.turns && conversation.turns.length > 0) {
		const firstTurn = conversation.turns[0];
		const startTime = firstTurn.startTime;
		if (startTime) {
			lines.push(`**Started:** ${new Date(startTime).toLocaleString()}`);
		}

		const lastTurn = conversation.turns[conversation.turns.length - 1];
		const endTime = lastTurn.startTime;
		if (endTime && endTime !== startTime) {
			lines.push(`**Last Activity:** ${new Date(endTime).toLocaleString()}`);
		}
	}

	lines.push('');
	lines.push('---');
	lines.push('');

	return lines;
}

/**
 * Builds the markdown content for all chat conversations export.
 * Creates a single document with all conversations separated by clear dividers.
 */
function buildAllChatsExportContent(allConversations: Array<{ responseId: string; conversation: any }>): string {
	const lines: string[] = [];

	// Add main header
	lines.push('# GitHub Copilot - All Chats Export');
	lines.push('');
	lines.push(`**Exported:** ${new Date().toLocaleString()}`);
	lines.push(`**Total Conversations:** ${allConversations.length}`);

	// Calculate total turns
	const totalTurns = allConversations.reduce((sum, item) => sum + (item.conversation.turns?.length || 0), 0);
	lines.push(`**Total Turns:** ${totalTurns}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Sort conversations by most recent first
	const sortedConversations = allConversations.sort((a, b) => {
		const aTime = a.conversation.turns.length > 0 ?
			a.conversation.turns[a.conversation.turns.length - 1].startTime || 0 : 0;
		const bTime = b.conversation.turns.length > 0 ?
			b.conversation.turns[b.conversation.turns.length - 1].startTime || 0 : 0;
		return bTime - aTime; // Most recent first
	});

	// Export each conversation
	sortedConversations.forEach((item, conversationIndex) => {
		const conversation = item.conversation;
		const responseId = item.responseId;

		// Add conversation header using helper function
		lines.push(...renderConversationHeader(conversation, responseId, conversationIndex));

		// Process each turn in the conversation using helper function
		if (conversation.turns) {
			for (let i = 0; i < conversation.turns.length; i++) {
				const turn = conversation.turns[i];

				// Render the complete turn
				lines.push(...renderTurn(turn, i));

				// Add separator between turns (except for the last turn)
				if (i < conversation.turns.length - 1) {
					lines.push('---');
					lines.push('');
				}
			}
		}

		// Add separator between conversations (except for the last conversation)
		if (conversationIndex < sortedConversations.length - 1) {
			lines.push('');
			lines.push('================================================================================');
			lines.push('');
		}
	});

	// Add footer
	lines.push('');
	lines.push('---');
	lines.push('');
	lines.push('*Exported from GitHub Copilot Chat Extension*');

	return lines.join('\n');
}

/**
 * Builds the markdown content for a chat conversation export.
 * Includes conversation metadata, turn-by-turn breakdown, and tool call information.
 */
export function buildChatExportContent(conversation: any): string {
	const lines: string[] = [];

	// Add main header
	lines.push('# GitHub Copilot Chat Export');
	lines.push('');

	// Use helper function for conversation metadata (passing dummy responseId and conversationIndex)
	const responseId = conversation.id || conversation.sessionId || 'N/A';
	lines.push(...renderConversationHeader(conversation, responseId, 0));

	// Process each turn in the conversation using helper function
	if (conversation.turns) {
		for (let i = 0; i < conversation.turns.length; i++) {
			const turn = conversation.turns[i];

			// Render the complete turn using helper function
			lines.push(...renderTurn(turn, i));

			// Add separator between turns (except for the last turn)
			if (i < conversation.turns.length - 1) {
				lines.push('---');
				lines.push('');
			}
		}
	} else {
		lines.push('*This conversation contains no turns.*');
		lines.push('');
	}

	// Add footer
	lines.push('');
	lines.push('---');
	lines.push('');
	lines.push('*Exported from GitHub Copilot Chat Extension*');

	return lines.join('\n');
}
