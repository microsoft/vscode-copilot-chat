/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { INSTRUCTION_FILE_EXTENSION, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../common/chatPromptFileService';

/**
 * Hook event IDs that Claude supports, matching the HookEvent types from
 * the Claude Agent SDK. Used to discover hooks from .claude/settings.json.
 */
const HOOK_EVENT_IDS = [
	'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
	'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop',
	'PreCompact', 'SessionStart', 'SessionEnd', 'Notification',
] as const;

interface HookConfig {
	readonly type: string;
	readonly command: string;
}

interface MatcherConfig {
	readonly matcher: string;
	readonly hooks: HookConfig[];
}

interface HooksSettings {
	readonly hooks?: Partial<Record<string, MatcherConfig[]>>;
}

export class ClaudeCustomizationProvider extends Disposable implements vscode.ChatSessionCustomizationProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	static get metadata(): vscode.ChatSessionCustomizationProviderMetadata {
		return {
			label: 'Claude',
			iconId: 'claude',
			unsupportedTypes: [vscode.ChatSessionCustomizationType.Agent, vscode.ChatSessionCustomizationType.Prompt],
			workspaceSubpaths: ['.claude'],
		};
	}

	constructor(
		@IChatPromptFileService private readonly chatPromptFileService: IChatPromptFileService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatPromptFileService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeInstructions(() => this._onDidChange.fire()));
		this._register(this.chatPromptFileService.onDidChangeSkills(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(_token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const items: vscode.ChatSessionCustomizationItem[] = [];

		for (const instruction of this.chatPromptFileService.instructions) {
			items.push({
				uri: instruction.uri,
				type: vscode.ChatSessionCustomizationType.Instructions,
				name: deriveNameFromUri(instruction.uri, INSTRUCTION_FILE_EXTENSION),
			});
		}

		for (const skill of this.chatPromptFileService.skills) {
			items.push({
				uri: skill.uri,
				type: vscode.ChatSessionCustomizationType.Skill,
				name: deriveNameFromUri(skill.uri, SKILL_FILENAME),
			});
		}

		// Discover hooks from .claude/settings.json files
		const hookItems = await this.discoverHooks();
		items.push(...hookItems);

		this.logService.trace(`[ClaudeCustomizationProvider] Provided ${items.length} customization items`);
		return items;
	}

	private async discoverHooks(): Promise<vscode.ChatSessionCustomizationItem[]> {
		const items: vscode.ChatSessionCustomizationItem[] = [];
		const settingsPaths = this.getSettingsFilePaths();

		for (const settingsUri of settingsPaths) {
			try {
				const content = await this.fileSystemService.readFile(settingsUri);
				const settings: HooksSettings = JSON.parse(new TextDecoder().decode(content));
				if (!settings.hooks) {
					continue;
				}

				for (const eventId of HOOK_EVENT_IDS) {
					const matchers = settings.hooks[eventId];
					if (!matchers || matchers.length === 0) {
						continue;
					}

					for (const matcher of matchers) {
						for (const hook of matcher.hooks) {
							const matcherLabel = matcher.matcher === '*' ? '' : ` (${matcher.matcher})`;
							items.push({
								uri: settingsUri,
								type: vscode.ChatSessionCustomizationType.Hook,
								name: `${eventId}${matcherLabel}`,
								description: hook.command,
							});
						}
					}
				}
			} catch {
				// Settings file doesn't exist or is invalid — skip
			}
		}

		return items;
	}

	private getSettingsFilePaths(): URI[] {
		const paths: URI[] = [];

		for (const folder of this.workspaceService.getWorkspaceFolders()) {
			paths.push(URI.joinPath(folder, '.claude', 'settings.json'));
			paths.push(URI.joinPath(folder, '.claude', 'settings.local.json'));
		}

		paths.push(URI.joinPath(this.envService.userHome, '.claude', 'settings.json'));
		return paths;
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
