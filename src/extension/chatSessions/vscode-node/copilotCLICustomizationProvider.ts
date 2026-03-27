/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { AGENT_FILE_EXTENSION, INSTRUCTION_FILE_EXTENSION, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../common/chatPromptFileService';

/** Workspace-relative path prefixes that are relevant to Copilot CLI. */
const CLI_SUBPATHS = ['.github/', '.copilot/'];

export class CopilotCLICustomizationProvider extends Disposable implements vscode.ChatSessionCustomizationProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	static get metadata(): vscode.ChatSessionCustomizationProviderMetadata {
		return {
			label: 'Copilot CLI',
			iconId: 'worktree',
			unsupportedTypes: [vscode.ChatSessionCustomizationType.Hook, vscode.ChatSessionCustomizationType.Prompt],
		};
	}

	constructor(
		@IChatPromptFileService private readonly chatPromptFileService: IChatPromptFileService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatPromptFileService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeInstructions(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeSkills(() => this._onDidChange.fire()));
	}

	provideChatSessionCustomizations(_token: vscode.CancellationToken): vscode.ChatSessionCustomizationItem[] {
		const items: vscode.ChatSessionCustomizationItem[] = [];

		// Agents (.agent.md) are Copilot-specific — include all of them
		for (const agent of this.chatPromptFileService.customAgents) {
			items.push({
				uri: agent.uri,
				type: vscode.ChatSessionCustomizationType.Agent,
				name: deriveNameFromUri(agent.uri, AGENT_FILE_EXTENSION),
			});
		}

		for (const instruction of this.chatPromptFileService.instructions) {
			if (this.isCLIPath(instruction.uri)) {
				items.push({
					uri: instruction.uri,
					type: vscode.ChatSessionCustomizationType.Instructions,
					name: deriveNameFromUri(instruction.uri, INSTRUCTION_FILE_EXTENSION),
				});
			}
		}

		for (const skill of this.chatPromptFileService.skills) {
			if (this.isCLIPath(skill.uri)) {
				items.push({
					uri: skill.uri,
					type: vscode.ChatSessionCustomizationType.Skill,
					name: deriveNameFromUri(skill.uri, SKILL_FILENAME),
				});
			}
		}

		this.logService.trace(`[CopilotCLICustomizationProvider] Provided ${items.length} customization items`);
		return items;
	}

	private isCLIPath(uri: URI): boolean {
		const folders = this.workspaceService.getWorkspaceFolders();
		for (const folder of folders) {
			const folderPath = folder.path.endsWith('/') ? folder.path : folder.path + '/';
			if (uri.path.startsWith(folderPath)) {
				const relative = uri.path.slice(folderPath.length);
				if (CLI_SUBPATHS.some(prefix => relative.startsWith(prefix))) {
					return true;
				}
			}
		}
		return false;
	}
}

function deriveNameFromUri(uri: vscode.Uri, extensionOrFilename: string): string {
	const filename = basename(uri);
	if (filename.toLowerCase() === extensionOrFilename.toLowerCase()) {
		// For files like SKILL.md, use the parent directory name
		const parts = uri.path.split('/');
		return parts.length >= 2 ? parts[parts.length - 2] : filename;
	}
	if (filename.endsWith(extensionOrFilename)) {
		return filename.slice(0, -extensionOrFilename.length);
	}
	return filename;
}
