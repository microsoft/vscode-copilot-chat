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

export function registerExportChatCommands(accessor: ServicesAccessor): IDisposable {
	const conversationStore = accessor.get(IConversationStore);
	const logService = accessor.get(ILogService);
	const telemetryService = accessor.get(ITelemetryService);

	const disposables = new DisposableStore();

	// Register the export chat command
	disposables.add(vscode.commands.registerCommand('github.copilot.chat.exportChat', async () => {
		try {
			await exportActiveChat(conversationStore, logService, telemetryService);
		} catch (error) {
			logService.error('Error exporting chat:', error);
			vscode.window.showErrorMessage(l10n.t('Failed to export chat: {0}', error instanceof Error ? error.message : String(error)));
		}
	}));

	return disposables;
}

async function exportActiveChat(
	conversationStore: IConversationStore,
	logService: ILogService,
	telemetryService: ITelemetryService
): Promise<void> {
	// Get the most recent conversation
	const lastConversation = conversationStore.lastConversation;

	if (!lastConversation) {
		vscode.window.showInformationMessage(l10n.t('No active chat conversation found to export.'));
		return;
	}

	// Build the chat content
	const chatContent = buildChatExportContent(lastConversation);

	if (!chatContent.trim()) {
		vscode.window.showInformationMessage(l10n.t('No chat content found to export.'));
		return;
	}

	// Show save dialog
	const saveOptions: vscode.SaveDialogOptions = {
		defaultUri: vscode.Uri.file(`copilot-chat-export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.md`),
		filters: {
			'Markdown': ['md'],
			'Text': ['txt']
		},
		saveLabel: l10n.t('Export Chat')
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
		l10n.t('Chat exported successfully to {0}', uri.fsPath),
		openChoice
	);

	if (choice === openChoice) {
		await vscode.window.showTextDocument(uri);
	}

	// Send telemetry
	telemetryService.sendMSFTTelemetryEvent('exportChat', {
		success: 'true',
		turnsCount: lastConversation.turns.length.toString()
	});

	logService.info(`Chat exported successfully to: ${uri.fsPath}`);
}

export function buildChatExportContent(conversation: any): string {
	const lines: string[] = [];

	// Add header
	lines.push('# GitHub Copilot Chat Export');
	lines.push('');
	lines.push(`**Exported:** ${new Date().toLocaleString()}`);
	lines.push(`**Conversation ID:** ${conversation.id || 'N/A'}`);
	lines.push(`**Total Turns:** ${conversation.turns?.length || 0}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Process each turn in the conversation
	if (conversation.turns) {
		for (let i = 0; i < conversation.turns.length; i++) {
			const turn = conversation.turns[i];

			// Add turn separator
			lines.push(`## Turn ${i + 1}`);
			lines.push('');

			// Add user request
			if (turn.request) {
				lines.push('### User Request');
				lines.push('');
				lines.push('```');
				lines.push(turn.request.message || turn.request.prompt || 'No message');
				lines.push('```');
				lines.push('');

				// Add any variables or context
				if (turn.request.variables) {
					lines.push('**Context Variables:**');
					for (const variable of turn.request.variables) {
						lines.push(`- **${variable.name}:** ${variable.value || 'N/A'}`);
					}
					lines.push('');
				}
			}

			// Add assistant response
			if (turn.responseMessage || turn.response) {
				lines.push('### Assistant Response');
				lines.push('');

				// Handle different response formats
				let responseContent = '';

				if (turn.responseMessage?.message) {
					responseContent = turn.responseMessage.message;
				} else if (turn.response) {
					// Handle response parts (like ChatResponseMarkdownPart)
					if (Array.isArray(turn.response)) {
						responseContent = turn.response.map((part: any) => {
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
						responseContent = String(turn.response);
					}
				}

				lines.push(responseContent || 'No response content');
				lines.push('');
			}

			// Add tool call information if available
			if (turn.resultMetadata?.toolCallRounds && turn.resultMetadata.toolCallRounds.length > 0) {
				lines.push('### Tool Calls');
				lines.push('');

				for (const toolRound of turn.resultMetadata.toolCallRounds) {
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

			// Add separator between turns (except for the last turn)
			if (i < conversation.turns.length - 1) {
				lines.push('---');
				lines.push('');
			}
		}
	}

	// Add footer
	lines.push('');
	lines.push('---');
	lines.push('');
	lines.push('*Exported from GitHub Copilot Chat Extension*');

	return lines.join('\n');
}
