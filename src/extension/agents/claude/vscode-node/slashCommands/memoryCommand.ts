/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { LanguageModelTextPart } from '../../../../../vscodeTypes';
import { IAnswerResult } from '../../../../tools/common/askQuestionsTypes';
import { ToolName } from '../../../../tools/common/toolNames';
import { IToolsService } from '../../../../tools/common/toolsService';
import { ClaudeFolderInfo } from '../../common/claudeFolderInfo';
import { IClaudeSlashCommandHandler, registerClaudeSlashCommand } from './claudeSlashCommandRegistry';

/**
 * MEMORY FILE LOCATIONS
 * =====================
 *
 * Claude memory files (CLAUDE.md) store persistent instructions that are included
 * in every conversation. There are three types:
 *
 * 1. User memory (~/.claude/CLAUDE.md)
 *    - Personal instructions that apply to all projects
 *    - Good for coding style preferences, frequently used patterns, etc.
 *
 * 2. Project memory (.claude/CLAUDE.md)
 *    - Project-specific instructions checked into version control
 *    - Shared with team members who clone the repository
 *
 * 3. Project memory - local (.claude/CLAUDE.local.md)
 *    - Project-specific instructions NOT checked into version control
 *    - For personal notes, local environment details, etc.
 */

/**
 * Memory file location type
 */
type MemoryLocationType = 'user' | 'project' | 'local';

/**
 * A resolved memory file location
 */
interface MemoryLocation {
	/** The type of memory location */
	type: MemoryLocationType;
	/** Display label */
	label: string;
	/** Description showing file path */
	description: string;
	/** Full URI to the memory file */
	path: URI;
	/** For project locations, the workspace folder URI */
	workspaceFolder?: URI;
}

/**
 * Slash command handler for opening Claude memory files (CLAUDE.md).
 * Shows a QuickPick to select which memory file to edit.
 */
export class MemorySlashCommand implements IClaudeSlashCommandHandler {
	readonly commandName = 'memory';
	readonly description = 'Open memory files (CLAUDE.md) for editing';
	readonly commandId = 'copilot.claude.memory';

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@ILogService private readonly logService: ILogService,
		@IToolsService private readonly toolsService: IToolsService,
	) { }

	async handle(
		_args: string,
		stream: vscode.ChatResponseStream | undefined,
		_token: CancellationToken,
		toolInvocationToken?: vscode.ChatParticipantToolToken,
		folderInfo?: ClaudeFolderInfo,
	): Promise<vscode.ChatResult> {
		if (toolInvocationToken) {
			return this._handleWithAskQuestions(stream, toolInvocationToken, folderInfo);
		}

		stream?.markdown(vscode.l10n.t('Opening memory file picker...'));

		// Fire and forget - picker runs in background
		this._runPicker().catch(error => {
			this.logService.error('[MemorySlashCommand] Error running memory picker:', error);
			vscode.window.showErrorMessage(
				vscode.l10n.t('Error opening memory file: {0}', error instanceof Error ? error.message : String(error))
			);
		});

		return {};
	}

	private async _handleWithAskQuestions(
		stream: vscode.ChatResponseStream | undefined,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		folderInfo?: ClaudeFolderInfo,
	): Promise<vscode.ChatResult> {
		const locations = this._getMemoryLocations(folderInfo);

		// If only one location is available, open it directly without asking
		if (locations.length === 1) {
			const location = locations[0];
			await this._openOrCreateMemoryFile(location);
			stream?.markdown(vscode.l10n.t('Opened memory file: {0}', location.label));
			return {};
		}

		// Build question options from memory locations
		const options: { label: string; description: string; location: MemoryLocation }[] = [];
		for (const location of locations) {
			const exists = await this._fileExists(location.path);
			options.push({
				label: exists ? location.label : vscode.l10n.t('{0} (will be created)', location.label),
				description: location.description,
				location,
			});
		}

		const questionHeader = vscode.l10n.t('Claude Memory');
		try {
			const result = await this.toolsService.invokeTool(ToolName.CoreAskQuestions, {
				input: {
					questions: [{
						header: questionHeader,
						question: vscode.l10n.t('Select memory file to edit'),
						options: options.map(o => ({
							label: o.label,
							description: o.description,
						})),
					}],
				},
				toolInvocationToken,
			}, CancellationToken.None);

			const firstPart = result.content.at(0);
			if (!(firstPart instanceof LanguageModelTextPart)) {
				return {};
			}

			const toolResult: IAnswerResult = JSON.parse(firstPart.value);
			const answer = toolResult.answers[questionHeader];
			if (!answer || answer.skipped || answer.selected.length === 0) {
				return {};
			}

			// Find the matching location by label
			const selectedLabel = answer.selected[0];
			const selectedOption = options.find(o => o.label === selectedLabel);
			if (selectedOption) {
				await this._openOrCreateMemoryFile(selectedOption.location);
				stream?.markdown(vscode.l10n.t('Opened memory file: {0}', selectedOption.location.label));
			}
		} catch (error) {
			this.logService.error('[MemorySlashCommand] Error using askQuestions tool:', error);
			vscode.window.showErrorMessage(
				vscode.l10n.t('Error opening memory file: {0}', error instanceof Error ? error.message : String(error))
			);
		}

		return {};
	}

	private async _runPicker(): Promise<void> {
		// Build list of memory locations
		const locations = this._getMemoryLocations();

		// Build QuickPick items with existence status
		const items = await this._buildQuickPickItems(locations);

		// Show QuickPick
		const selected = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Claude Memory'),
			placeHolder: vscode.l10n.t('Select memory file to edit'),
			ignoreFocusOut: true,
		});

		if (selected) {
			await this._openOrCreateMemoryFile(selected.location);
		}
	}

	private _getMemoryLocations(folderInfo?: ClaudeFolderInfo): MemoryLocation[] {
		const locations: MemoryLocation[] = [];
		const homeDir = this.envService.userHome.fsPath;

		// User memory (always available)
		const userPath = URI.joinPath(this.envService.userHome, '.claude', 'CLAUDE.md');
		let userDisplayPath = userPath.fsPath;
		if (homeDir && userDisplayPath.startsWith(homeDir)) {
			userDisplayPath = '~' + userDisplayPath.slice(homeDir.length);
		}
		locations.push({
			type: 'user',
			label: vscode.l10n.t('User memory'),
			description: userDisplayPath,
			path: userPath,
		});

		// Project memories: use session folder info when available, otherwise all workspace folders
		const workspaceFolders = folderInfo
			? [URI.file(folderInfo.cwd), ...folderInfo.additionalDirectories.map(d => URI.file(d))]
			: this.workspaceService.getWorkspaceFolders();
		for (const folder of workspaceFolders) {
			const folderName = this.workspaceService.getWorkspaceFolderName(folder);
			const isMultiRoot = workspaceFolders.length > 1;

			// Project memory (shared, checked in)
			locations.push({
				type: 'project',
				label: isMultiRoot
					? vscode.l10n.t('Project memory - {0}', folderName)
					: vscode.l10n.t('Project memory'),
				description: '.claude/CLAUDE.md',
				path: URI.joinPath(folder, '.claude', 'CLAUDE.md'),
				workspaceFolder: folder,
			});

			// Project memory (local, git-ignored)
			locations.push({
				type: 'local',
				label: isMultiRoot
					? vscode.l10n.t('Project memory (local) - {0}', folderName)
					: vscode.l10n.t('Project memory (local)'),
				description: '.claude/CLAUDE.local.md',
				path: URI.joinPath(folder, '.claude', 'CLAUDE.local.md'),
				workspaceFolder: folder,
			});
		}

		return locations;
	}

	private async _buildQuickPickItems(locations: MemoryLocation[]): Promise<(vscode.QuickPickItem & { location: MemoryLocation })[]> {
		const items: (vscode.QuickPickItem & { location: MemoryLocation })[] = [];

		for (const location of locations) {
			const exists = await this._fileExists(location.path);

			items.push({
				label: exists ? `$(file) ${location.label}` : `$(file-add) ${location.label}`,
				description: exists ? location.description : vscode.l10n.t('{0} (will be created)', location.description),
				location,
			});
		}

		return items;
	}

	private async _fileExists(path: URI): Promise<boolean> {
		try {
			await this.fileSystemService.stat(path);
			return true;
		} catch {
			return false;
		}
	}

	private async _openOrCreateMemoryFile(location: MemoryLocation): Promise<void> {
		const exists = await this._fileExists(location.path);

		if (!exists) {
			// Create directory if needed
			const dir = URI.joinPath(location.path, '..');
			await createDirectoryIfNotExists(this.fileSystemService, dir);

			// Create with template
			const template = this._getTemplate(location.type);
			await this.fileSystemService.writeFile(location.path, new TextEncoder().encode(template));
		}

		// Open in editor
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(location.path.fsPath));
		await vscode.window.showTextDocument(doc);
	}

	private _getTemplate(type: MemoryLocationType): string {
		switch (type) {
			case 'user':
				return `# User Memory

Instructions here apply to all projects.

## Preferences

`;
			case 'project':
				return `# Project Memory

Instructions here apply to this project and are shared with team members.

## Context

`;
			case 'local':
				return `# Project Memory (Local)

Instructions here apply to this project but should not be checked into version control.

## Local Notes

`;
		}
	}
}

// Self-register the memory command
registerClaudeSlashCommand(MemorySlashCommand);
