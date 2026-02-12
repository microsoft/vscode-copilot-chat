/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { AzureDevOpsClient } from '../../common/azureDevOps/azureDevOpsClient';
import { IClaudeSlashCommandHandler, registerClaudeSlashCommand } from './claudeSlashCommandRegistry';

/**
 * Quick pick item for Azure DevOps slash command actions
 */
interface DevOpsQuickPickItem extends vscode.QuickPickItem {
	readonly action: 'query' | 'get' | 'my-items' | 'configure';
}

/**
 * Slash command handler for Azure DevOps work item operations.
 * Provides a quick pick menu for common operations and also supports
 * inline arguments for power users.
 *
 * Usage:
 *   /devops             - Shows action picker
 *   /devops <id>        - Gets a work item by ID
 *   /devops my items    - Shows work items assigned to you
 *   /devops <query>     - Runs a natural language search
 */
export class DevOpsSlashCommand implements IClaudeSlashCommandHandler {
	readonly commandName = 'devops';
	readonly description = 'Azure DevOps work items - search, view, and manage';
	readonly commandId = 'copilot.claude.devops';

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async handle(
		args: string,
		stream: vscode.ChatResponseStream | undefined,
		_token: CancellationToken
	): Promise<vscode.ChatResult> {
		if (!this.client.isConfigured()) {
			stream?.markdown(
				'Azure DevOps is not configured. Please set the following in your VS Code settings:\n\n' +
				'- `yourcompany.ado.orgUrl` - Your Azure DevOps organization URL (e.g., `https://dev.azure.com/your-org`)\n' +
				'- `yourcompany.ado.pat` - Your Personal Access Token\n' +
				'- `yourcompany.ado.defaultProject` - (Optional) Default project name\n\n' +
				'You can open settings with the command: **Preferences: Open Settings (UI)**'
			);
			return {};
		}

		const trimmedArgs = args.trim();

		// If an ID was passed directly, fetch that work item
		const idMatch = trimmedArgs.match(/^#?(\d+)$/);
		if (idMatch) {
			return this._getWorkItem(parseInt(idMatch[1], 10), stream);
		}

		// If "my items" or similar was passed, show assigned items
		if (/^my\s*(items?|work|tasks?|bugs?)?$/i.test(trimmedArgs)) {
			return this._getMyItems(stream);
		}

		// If any other args were passed, treat as a search hint
		if (trimmedArgs.length > 0) {
			stream?.markdown(`Searching for work items matching: **${trimmedArgs}**\n\nUse the Azure DevOps tools (ado_queryWorkItems) in the conversation to run the search with full WIQL support.`);
			return {};
		}

		// No args - show the action picker
		this._showActionPicker(stream).catch(() => { /* swallow - user cancelled */ });
		return {};
	}

	private async _getWorkItem(id: number, stream: vscode.ChatResponseStream | undefined): Promise<vscode.ChatResult> {
		try {
			stream?.markdown(`Fetching work item **#${id}**...\n\n`);
			const workItem = await this.client.getWorkItem(id);
			stream?.markdown(this.client.formatWorkItem(workItem));
		} catch (e) {
			stream?.markdown(`Failed to fetch work item #${id}: ${e instanceof Error ? e.message : String(e)}`);
		}
		return {};
	}

	private async _getMyItems(stream: vscode.ChatResponseStream | undefined): Promise<vscode.ChatResult> {
		try {
			stream?.markdown('Fetching your active work items...\n\n');
			const wiql = "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.AssignedTo] = @me AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC";
			const queryResult = await this.client.queryWorkItems(wiql, undefined, 15);

			if (queryResult.workItems.length === 0) {
				stream?.markdown('No active work items assigned to you.');
				return {};
			}

			const ids = queryResult.workItems.map(wi => wi.id);
			const workItems = await this.client.getWorkItems(ids);

			stream?.markdown(`Found **${workItems.length}** active work item(s) assigned to you:\n\n`);

			for (const wi of workItems) {
				const fields = wi.fields;
				const state = fields['System.State'] ?? '';
				const type = fields['System.WorkItemType'] ?? '';
				const title = fields['System.Title'] ?? '';
				stream?.markdown(`- **#${wi.id}** [${type}] ${title} *(${state})*\n`);
			}
		} catch (e) {
			stream?.markdown(`Failed to fetch your work items: ${e instanceof Error ? e.message : String(e)}`);
		}
		return {};
	}

	private async _showActionPicker(stream: vscode.ChatResponseStream | undefined): Promise<void> {
		stream?.markdown('Opening Azure DevOps action picker...');

		const items: DevOpsQuickPickItem[] = [
			{
				label: '$(search) My Work Items',
				description: 'Show work items assigned to me',
				action: 'my-items',
			},
			{
				label: '$(number) Get Work Item by ID',
				description: 'Fetch a specific work item',
				action: 'get',
			},
			{
				label: '$(database) Run WIQL Query',
				description: 'Search using Work Item Query Language',
				action: 'query',
			},
			{
				label: '$(gear) Configure',
				description: 'Open Azure DevOps settings',
				action: 'configure',
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Azure DevOps'),
			placeHolder: vscode.l10n.t('Select an action'),
		});

		if (!selected) {
			return;
		}

		switch (selected.action) {
			case 'my-items':
				await this._getMyItems(stream);
				break;
			case 'get': {
				const idInput = await vscode.window.showInputBox({
					title: vscode.l10n.t('Work Item ID'),
					placeHolder: vscode.l10n.t('Enter work item ID (e.g., 12345)'),
					validateInput: value => {
						if (!/^\d+$/.test(value.trim())) {
							return vscode.l10n.t('Please enter a valid numeric ID');
						}
						return undefined;
					},
				});
				if (idInput) {
					await this._getWorkItem(parseInt(idInput.trim(), 10), stream);
				}
				break;
			}
			case 'query': {
				const wiql = await vscode.window.showInputBox({
					title: vscode.l10n.t('WIQL Query'),
					placeHolder: vscode.l10n.t("SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.State] = 'Active'"),
				});
				if (wiql) {
					try {
						const queryResult = await this.client.queryWorkItems(wiql, undefined, 20);
						if (queryResult.workItems.length === 0) {
							stream?.markdown('No work items found.');
						} else {
							const ids = queryResult.workItems.map(wi => wi.id);
							const workItems = await this.client.getWorkItems(ids);
							const formatted = workItems.map(wi => this.client.formatWorkItem(wi)).join('\n---\n\n');
							stream?.markdown(formatted);
						}
					} catch (e) {
						stream?.markdown(`Query failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				break;
			}
			case 'configure':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'yourcompany.ado');
				break;
		}
	}
}

// Self-register the slash command
registerClaudeSlashCommand(DevOpsSlashCommand);
