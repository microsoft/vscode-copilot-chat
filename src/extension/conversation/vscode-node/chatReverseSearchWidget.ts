/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatHistoryItem, IChatHistoryService } from '../common/chatHistoryService';

export class ChatReverseSearchWidget {

	constructor(
		@IChatHistoryService private readonly chatHistoryService: IChatHistoryService
	) { }

	async showReverseSearch(): Promise<void> {
		const history = this.chatHistoryService.getHistory();

		const quickPick = vscode.window.createQuickPick<ChatHistoryQuickPickItem>();
		quickPick.title = 'GitHub Copilot Chat History';
		quickPick.placeholder = history.length === 0
			? 'No chat history found. Start chatting to build your history...'
			: 'Search your chat history...';

		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.canSelectMany = false;

		// Add history reset button
		quickPick.buttons = [
			{
				iconPath: new vscode.ThemeIcon('trash'),
				tooltip: 'Clear Chat History'
			}
		];

		quickPick.items = this.createQuickPickItems(history);

		// Handle search input
		quickPick.onDidChangeValue((query) => {
			if (query.trim()) {
				const filteredHistory = this.chatHistoryService.searchHistory(query);
				quickPick.items = this.createQuickPickItems(filteredHistory);
			} else {
				quickPick.items = this.createQuickPickItems(this.chatHistoryService.getHistory());
			}
		});

		// Handle button clicks
		quickPick.onDidTriggerButton(async (button) => {
			if (button.tooltip === 'Clear Chat History') {
				const confirm = await vscode.window.showInformationMessage(
					'Are you sure you want to clear all chat history?',
					{ modal: true },
					'Yes',
					'No'
				);

				if (confirm === 'Yes') {
					await this.chatHistoryService.clearAllStoredData();
					quickPick.items = this.createQuickPickItems([]);
					quickPick.placeholder = 'History cleared. Start chatting to build your history...';
				}
			}
		});

		// Handle selection
		quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (selected) {
				// Set text in chat input without sending
				this.setChatInputText(selected.text);
			}
			quickPick.dispose();
		});

		quickPick.onDidHide(() => quickPick.dispose());
		quickPick.show();
	}

	private async setChatInputText(text: string): Promise<void> {
		try {
			// Save current clipboard content
			const originalClipboard = await vscode.env.clipboard.readText();

			// Copy our text to clipboard
			await vscode.env.clipboard.writeText(text);

			// Open chat view and ensure it's focused
			await vscode.commands.executeCommand('workbench.action.chat.open');

			// Wait for the view to be ready
			await new Promise(resolve => setTimeout(resolve, 200));

			// Clear any existing input and paste our text
			await vscode.commands.executeCommand('editor.action.selectAll');
			await vscode.commands.executeCommand('editor.action.clipboardPasteAction');

			// Restore original clipboard content
			await vscode.env.clipboard.writeText(originalClipboard);

		} catch (error) {
			console.warn('Could not set chat input text via clipboard, using fallback:', error);
			// Fallback: just open chat normally and let user manually paste if needed
			await vscode.commands.executeCommand('workbench.action.chat.open');

			// Show info message with the text user can copy
			const copyAction = 'Copy Text';
			const result = await vscode.window.showInformationMessage(
				`Selected text: "${text.length > 50 ? text.substring(0, 50) + '...' : text}"`,
				copyAction
			);

			if (result === copyAction) {
				await vscode.env.clipboard.writeText(text);
				vscode.window.showInformationMessage('Text copied to clipboard. You can paste it in chat.');
			}
		}
	}

	private createQuickPickItems(history: ChatHistoryItem[]): ChatHistoryQuickPickItem[] {
		// Sort by timestamp descending (most recent first)
		const sortedHistory = history.sort((a, b) => b.timestamp - a.timestamp);

		return sortedHistory.map((item, index) => {
			const truncatedText = this.truncateText(item.text, 50); // More space for text
			const timeString = this.formatTimestamp(item.timestamp);

			// Fixed width timestamp + cool separator + text
			const labelWithTimestamp = `${timeString.padEnd(12)} ▸ ${truncatedText}`;

			return {
				label: labelWithTimestamp,
				description: undefined,
				detail: item.text.length > 50 ? item.text : undefined,
				text: item.text,
				timestamp: item.timestamp
			};
		});
	}

	private formatTimestamp(timestamp: number): string {
		const date = new Date(timestamp);

		// Format as DD.MM HH:MM (24-hour format, no year/seconds)
		const day = date.getDate().toString().padStart(2, '0');
		const month = (date.getMonth() + 1).toString().padStart(2, '0');
		const hours = date.getHours().toString().padStart(2, '0');
		const minutes = date.getMinutes().toString().padStart(2, '0');

		return `${day}.${month} ${hours}:${minutes}`;
	}

	private truncateText(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}
		return text.substring(0, maxLength - 3) + '...';
	}
}

interface ChatHistoryQuickPickItem extends vscode.QuickPickItem {
	text: string;
	timestamp: number;
}
