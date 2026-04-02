/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { INSTRUCTION_FILE_EXTENSION, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../common/chatPromptFileService';
import { ICopilotCLIAgents } from '../copilotcli/node/copilotCli';

/** Workspace-relative prefixes the copilot-agent-runtime discovers. */
const CLI_WORKSPACE_PREFIXES = ['.github/', '.copilot/', '.agents/'];

/** Home-directory prefixes the copilot-agent-runtime discovers. */
const CLI_HOME_PREFIXES = ['.copilot/', '.agents/'];

export class CopilotCLICustomizationProvider extends Disposable implements vscode.ChatSessionCustomizationProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	static get metadata(): vscode.ChatSessionCustomizationProviderMetadata {
		return {
			label: 'Copilot CLI',
			iconId: 'worktree',
			supportedTypes: [
				vscode.ChatSessionCustomizationType.Agent,
				vscode.ChatSessionCustomizationType.Skill,
				vscode.ChatSessionCustomizationType.Instructions,
			],
		};
	}

	constructor(
		@IChatPromptFileService private readonly chatPromptFileService: IChatPromptFileService,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatPromptFileService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeInstructions(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeSkills(() => this._onDidChange.fire()));
		this._register(this.copilotCLIAgents.onDidChangeAgents(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(_token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const agents = await this.getAgentItems();
		const instructions = this.getInstructionItems();
		const skills = this.getSkillItems();

		this.logService.debug(`[CopilotCLICustomizationProvider] agents (${agents.length}): ${agents.map(a => a.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] instructions (${instructions.length}): ${instructions.map(i => i.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] skills (${skills.length}): ${skills.map(s => s.name).join(', ') || '(none)'}`);

		const items = [...agents, ...instructions, ...skills];
		this.logService.debug(`[CopilotCLICustomizationProvider] total: ${items.length} items`);
		return items;
	}

	/**
	 * Builds agent items from ICopilotCLIAgents, which already merges SDK
	 * and prompt-file agents with source URIs.
	 */
	private async getAgentItems(): Promise<vscode.ChatSessionCustomizationItem[]> {
		const agentInfos = await this.copilotCLIAgents.getAgents();
		return agentInfos.map(({ agent, sourceUri }) => ({
			uri: sourceUri,
			type: vscode.ChatSessionCustomizationType.Agent,
			name: agent.displayName || agent.name,
			description: agent.description,
		}));
	}

	/**
	 * Collects instruction items from prompt files under CLI-recognized paths.
	 */
	private getInstructionItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.instructions
			.filter(i => this.isCLIPath(i.uri))
			.map(i => ({
				uri: i.uri,
				type: vscode.ChatSessionCustomizationType.Instructions,
				name: deriveNameFromUri(i.uri, INSTRUCTION_FILE_EXTENSION),
			}));
	}

	/**
	 * Collects skill items from prompt files under CLI-recognized paths.
	 */
	private getSkillItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.skills
			.filter(s => this.isCLIPath(s.uri))
			.map(s => ({
				uri: s.uri,
				type: vscode.ChatSessionCustomizationType.Skill,
				name: deriveNameFromUri(s.uri, SKILL_FILENAME),
			}));
	}

	private isCLIPath(uri: URI): boolean {
		// Check workspace folder paths
		const folders = this.workspaceService.getWorkspaceFolders();
		for (const folder of folders) {
			const folderPath = folder.path.endsWith('/') ? folder.path : folder.path + '/';
			if (uri.path.startsWith(folderPath)) {
				const relative = uri.path.slice(folderPath.length);
				if (CLI_WORKSPACE_PREFIXES.some(prefix => relative.startsWith(prefix))) {
					return true;
				}
			}
		}

		// Check home directory paths (e.g., ~/.copilot/skills/, ~/.agents/skills/)
		const homePath = this.envService.userHome.path;
		const homePrefix = homePath.endsWith('/') ? homePath : homePath + '/';
		if (uri.path.startsWith(homePrefix)) {
			const relative = uri.path.slice(homePrefix.length);
			if (CLI_HOME_PREFIXES.some(prefix => relative.startsWith(prefix))) {
				return true;
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
