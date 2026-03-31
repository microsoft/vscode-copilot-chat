/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AGENT_FILE_EXTENSION, INSTRUCTION_FILE_EXTENSION, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../common/chatPromptFileService';
import { ICopilotCLIAgents } from '../copilotcli/node/copilotCli';

/**
 * Workspace-relative path prefixes that are relevant to Copilot CLI.
 * Matches the copilot-agent-runtime discovery paths for skills, instructions, and agents.
 */
const CLI_SUBPATHS = ['.github/', '.copilot/', '.agents/'];

/**
 * Home-directory relative path prefixes for Copilot CLI customizations.
 * Matches the copilot-agent-runtime personal skill/instruction directories.
 */
const CLI_HOME_SUBPATHS = ['.copilot/', '.agents/'];

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
		const items: vscode.ChatSessionCustomizationItem[] = [];

		// Build a file URI lookup from prompt file agents for cross-referencing
		const fileAgentLookup = new Map<string, URI>();
		for (const agent of this.chatPromptFileService.customAgents) {
			const name = deriveNameFromUri(agent.uri, AGENT_FILE_EXTENSION);
			fileAgentLookup.set(name.toLowerCase(), agent.uri);
		}

		// Agents: use ICopilotCLIAgents as the primary source (includes SDK + prompt file agents).
		// Cross-reference with chatPromptFileService.customAgents for file URIs when available.
		const cliAgents = await this.copilotCLIAgents.getAgents();
		const agentItems: vscode.ChatSessionCustomizationItem[] = [];
		for (const agent of cliAgents) {
			const fileUri = fileAgentLookup.get(agent.name.toLowerCase());
			agentItems.push({
				uri: fileUri ?? URI.from({ scheme: 'copilotcli', path: `/agents/${agent.name}` }),
				type: vscode.ChatSessionCustomizationType.Agent,
				name: agent.displayName || agent.name,
				description: agent.description,
				groupKey: fileUri ? undefined : 'Built-in',
			});
		}
		items.push(...agentItems);
		this.logService.debug(`[CopilotCLICustomizationProvider] agents (${agentItems.length}): ${agentItems.map(a => a.name).join(', ') || '(none)'}`);

		const instructionItems: vscode.ChatSessionCustomizationItem[] = [];
		for (const instruction of this.chatPromptFileService.instructions) {
			if (this.isCLIPath(instruction.uri)) {
				instructionItems.push({
					uri: instruction.uri,
					type: vscode.ChatSessionCustomizationType.Instructions,
					name: deriveNameFromUri(instruction.uri, INSTRUCTION_FILE_EXTENSION),
				});
			}
		}
		items.push(...instructionItems);
		this.logService.debug(`[CopilotCLICustomizationProvider] instructions (${instructionItems.length}): ${instructionItems.map(i => i.name).join(', ') || '(none)'}`);

		const skillItems: vscode.ChatSessionCustomizationItem[] = [];
		for (const skill of this.chatPromptFileService.skills) {
			if (this.isCLIPath(skill.uri)) {
				skillItems.push({
					uri: skill.uri,
					type: vscode.ChatSessionCustomizationType.Skill,
					name: deriveNameFromUri(skill.uri, SKILL_FILENAME),
				});
			}
		}
		items.push(...skillItems);
		this.logService.debug(`[CopilotCLICustomizationProvider] skills (${skillItems.length}): ${skillItems.map(s => s.name).join(', ') || '(none)'}`);

		this.logService.debug(`[CopilotCLICustomizationProvider] total: ${items.length} items`);
		return items;
	}

	private isCLIPath(uri: URI): boolean {
		// Check workspace folder paths
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

		// Check home directory paths (e.g., ~/.copilot/skills/, ~/.agents/skills/)
		const homePath = this.envService.userHome.path;
		const homePrefix = homePath.endsWith('/') ? homePath : homePath + '/';
		if (uri.path.startsWith(homePrefix)) {
			const relative = uri.path.slice(homePrefix.length);
			if (CLI_HOME_SUBPATHS.some(prefix => relative.startsWith(prefix))) {
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
