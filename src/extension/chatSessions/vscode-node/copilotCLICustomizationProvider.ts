/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { INSTRUCTION_FILE_EXTENSION, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { IChatPromptFileService } from '../common/chatPromptFileService';
import { ICopilotCLIAgents } from '../copilotcli/node/copilotCli';

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
				vscode.ChatSessionCustomizationType.Hook,
				vscode.ChatSessionCustomizationType.Plugins,
			],
		};
	}

	constructor(
		@IChatPromptFileService private readonly chatPromptFileService: IChatPromptFileService,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatPromptFileService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeInstructions(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeSkills(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeHooks(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangePlugins(() => this._onDidChange.fire()));
		this._register(this.copilotCLIAgents.onDidChangeAgents(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(_token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const agents = await this.getAgentItems();
		const instructions = this.getInstructionItems();
		const skills = this.getSkillItems();
		const hooks = this.getHookItems();
		const plugins = this.getPluginItems();

		this.logService.debug(`[CopilotCLICustomizationProvider] agents (${agents.length}): ${agents.map(a => a.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] instructions (${instructions.length}): ${instructions.map(i => i.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] skills (${skills.length}): ${skills.map(s => s.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] hooks (${hooks.length}): ${hooks.map(h => h.name).join(', ') || '(none)'}`);

		this.logService.debug(`[CopilotCLICustomizationProvider] plugins (${plugins.length}): ${plugins.map(p => p.name).join(', ') || '(none)'}`);

		const items = [...agents, ...instructions, ...skills, ...hooks, ...plugins];
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
	 * Collects all instruction items from the prompt file service.
	 */
	private getInstructionItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.instructions.map(i => ({
			uri: i.uri,
			type: vscode.ChatSessionCustomizationType.Instructions,
			name: deriveNameFromUri(i.uri, INSTRUCTION_FILE_EXTENSION),
		}));
	}

	/**
	 * Collects all skill items from the prompt file service.
	 */
	private getSkillItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.skills.map(s => ({
			uri: s.uri,
			type: vscode.ChatSessionCustomizationType.Skill,
			name: deriveNameFromUri(s.uri, SKILL_FILENAME),
		}));
	}

	/**
	 * Collects all hook items from the prompt file service.
	 * Each item is a hook configuration file (JSON).
	 */
	private getHookItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.hooks.map(h => ({
			uri: h.uri,
			type: vscode.ChatSessionCustomizationType.Hook,
			name: basename(h.uri).replace(/\.json$/i, ''),
		}));
	}

	/**	 * Collects all plugin items from the prompt file service.
	 */
	private getPluginItems(): vscode.ChatSessionCustomizationItem[] {
		return this.chatPromptFileService.plugins.map(p => ({
			uri: p.uri,
			type: vscode.ChatSessionCustomizationType.Plugins,
			name: basename(p.uri),
		}));
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
