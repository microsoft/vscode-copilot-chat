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
	 * Builds agent items by merging CLI SDK agents with prompt file agents.
	 *
	 * Uses ICopilotCLIAgents as the primary source, then cross-references with
	 * chatPromptFileService.customAgents to resolve file URIs. Matching is by
	 * exact normalized name (lowercase, no hyphens/underscores). Unmatched file
	 * agents are included only if they live under a CLI-recognized path.
	 */
	private async getAgentItems(): Promise<vscode.ChatSessionCustomizationItem[]> {
		// Build a file URI lookup from prompt file agents for cross-referencing.
		const fileAgentLookup = new Map<string, { uri: URI; name: string }>();
		for (const agent of this.chatPromptFileService.customAgents) {
			const name = deriveNameFromUri(agent.uri, AGENT_FILE_EXTENSION);
			fileAgentLookup.set(normalizeName(name), { uri: agent.uri, name });
		}

		// Walk CLI agents and resolve each to a file URI or synthetic URI.
		const cliAgents = await this.copilotCLIAgents.getAgents();
		const matchedFileKeys = new Set<string>();
		const items: vscode.ChatSessionCustomizationItem[] = [];
		const seenUris = new Set<string>();

		for (const agent of cliAgents) {
			const key = normalizeName(agent.name);
			const matchedFile = fileAgentLookup.get(key);
			if (matchedFile) {
				matchedFileKeys.add(key);
			}
			const uri = matchedFile?.uri ?? URI.from({ scheme: 'copilotcli', path: `/agents/${agent.name}` });
			const uriKey = uri.toString();
			if (seenUris.has(uriKey)) {
				continue; // Another CLI agent already claimed this URI
			}
			seenUris.add(uriKey);
			items.push({
				uri,
				type: vscode.ChatSessionCustomizationType.Agent,
				name: matchedFile?.name ?? (agent.displayName || agent.name),
				description: agent.description,
			});
		}

		// Add file-based agents not matched by any CLI agent, filtered to CLI paths.
		for (const [key, file] of fileAgentLookup) {
			if (!matchedFileKeys.has(key) && this.isCLIPath(file.uri) && !seenUris.has(file.uri.toString())) {
				seenUris.add(file.uri.toString());
				items.push({
					uri: file.uri,
					type: vscode.ChatSessionCustomizationType.Agent,
					name: file.name,
				});
			}
		}

		return items;
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

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[-_]/g, '');
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
