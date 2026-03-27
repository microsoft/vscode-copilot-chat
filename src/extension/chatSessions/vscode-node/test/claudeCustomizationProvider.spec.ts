/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../../common/chatPromptFileService';
import { ClaudeCustomizationProvider } from '../claudeCustomizationProvider';

class FakeChatSessionCustomizationType {
	static readonly Agent = new FakeChatSessionCustomizationType('agent');
	static readonly Skill = new FakeChatSessionCustomizationType('skill');
	static readonly Instructions = new FakeChatSessionCustomizationType('instructions');
	static readonly Prompt = new FakeChatSessionCustomizationType('prompt');
	static readonly Hook = new FakeChatSessionCustomizationType('hook');
	constructor(readonly id: string) { }
}

class MockChatPromptFileService extends mock<IChatPromptFileService>() {
	private readonly _onDidChangeCustomAgents = new Emitter<void>();
	override readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;
	private readonly _onDidChangeInstructions = new Emitter<void>();
	override readonly onDidChangeInstructions = this._onDidChangeInstructions.event;
	private readonly _onDidChangeSkills = new Emitter<void>();
	override readonly onDidChangeSkills = this._onDidChangeSkills.event;

	private _customAgents: vscode.ChatResource[] = [];
	private _instructions: vscode.ChatResource[] = [];
	private _skills: vscode.ChatResource[] = [];

	override get customAgents(): readonly vscode.ChatResource[] { return this._customAgents; }
	override get instructions(): readonly vscode.ChatResource[] { return this._instructions; }
	override get skills(): readonly vscode.ChatResource[] { return this._skills; }

	setCustomAgents(agents: vscode.ChatResource[]) { this._customAgents = agents; }
	setInstructions(instructions: vscode.ChatResource[]) { this._instructions = instructions; }
	setSkills(skills: vscode.ChatResource[]) { this._skills = skills; }

	fireCustomAgentsChanged() { this._onDidChangeCustomAgents.fire(); }
	fireInstructionsChanged() { this._onDidChangeInstructions.fire(); }
	fireSkillsChanged() { this._onDidChangeSkills.fire(); }

	override dispose() {
		this._onDidChangeCustomAgents.dispose();
		this._onDidChangeInstructions.dispose();
		this._onDidChangeSkills.dispose();
	}
}

class MockWorkspaceService extends mock<IWorkspaceService>() {
	private _folders: URI[] = [];
	setFolders(folders: URI[]) { this._folders = folders; }
	override getWorkspaceFolders(): URI[] { return this._folders; }
}

class MockFileSystemService extends mock<IFileSystemService>() {
	private readonly _files = new Map<string, Uint8Array>();
	setFile(uri: URI, content: string) {
		this._files.set(uri.toString(), new TextEncoder().encode(content));
	}
	override async readFile(uri: URI): Promise<Uint8Array> {
		const content = this._files.get(uri.toString());
		if (!content) {
			throw new Error(`File not found: ${uri.toString()}`);
		}
		return content;
	}
}

class MockEnvService extends mock<INativeEnvService>() {
	override userHome = URI.file('/home/user');
}

class TestLogService extends mock<ILogService>() {
	override trace() { }
}

describe('ClaudeCustomizationProvider', () => {
	let disposables: DisposableStore;
	let mockPromptFileService: MockChatPromptFileService;
	let mockWorkspaceService: MockWorkspaceService;
	let mockFileSystemService: MockFileSystemService;
	let provider: ClaudeCustomizationProvider;

	beforeEach(() => {
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = FakeChatSessionCustomizationType;
		disposables = new DisposableStore();
		mockPromptFileService = disposables.add(new MockChatPromptFileService());
		mockWorkspaceService = new MockWorkspaceService();
		mockFileSystemService = new MockFileSystemService();
		provider = disposables.add(new ClaudeCustomizationProvider(
			mockPromptFileService,
			mockWorkspaceService,
			mockFileSystemService,
			new MockEnvService(),
			new TestLogService(),
		));
	});

	afterEach(() => {
		disposables.dispose();
	});

	describe('metadata', () => {
		it('has correct label and icon', () => {
			expect(ClaudeCustomizationProvider.metadata.label).toBe('Claude');
			expect(ClaudeCustomizationProvider.metadata.iconId).toBe('claude');
		});

		it('marks Prompt type as unsupported', () => {
			const unsupported = ClaudeCustomizationProvider.metadata.unsupportedTypes;
			expect(unsupported).toBeDefined();
			expect(unsupported).toHaveLength(1);
			expect(unsupported![0]).toBe(FakeChatSessionCustomizationType.Prompt);
		});

		it('scopes to .claude workspace subpath', () => {
			expect(ClaudeCustomizationProvider.metadata.workspaceSubpaths).toEqual(['.claude']);
		});
	});

	describe('provideChatSessionCustomizations', () => {
		it('returns empty array when no files exist', async () => {
			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('returns agents with Agent type', async () => {
			const uri = URI.file('/workspace/.claude/my-helper.agent.md');
			mockPromptFileService.setCustomAgents([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Agent);
			expect(items[0].name).toBe('my-helper');
		});

		it('returns instructions with Instructions type', async () => {
			const uri = URI.file('/workspace/.claude/setup.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
			expect(items[0].name).toBe('setup');
		});

		it('returns skills with Skill type and derives name from parent dir', async () => {
			const uri = URI.file('/workspace/.claude/skills/my-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
			expect(items[0].name).toBe('my-skill');
		});

		it('returns all types combined', async () => {
			mockPromptFileService.setCustomAgents([{ uri: URI.file('/a.agent.md') }]);
			mockPromptFileService.setInstructions([{ uri: URI.file('/b.instructions.md') }]);
			mockPromptFileService.setSkills([{ uri: URI.file('/skills/c/SKILL.md') }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(3);
		});
	});

	describe('hook discovery', () => {
		it('discovers hooks from workspace .claude/settings.json', async () => {
			const workspaceFolder = URI.file('/workspace');
			mockWorkspaceService.setFolders([workspaceFolder]);
			const settingsUri = URI.joinPath(workspaceFolder, '.claude', 'settings.json');
			mockFileSystemService.setFile(settingsUri, JSON.stringify({
				hooks: {
					PreToolUse: [
						{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/pre-bash.sh' }] }
					]
				}
			}));

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const hookItems = items.filter(i => i.type === FakeChatSessionCustomizationType.Hook);
			expect(hookItems).toHaveLength(1);
			expect(hookItems[0].name).toBe('PreToolUse (Bash)');
			expect(hookItems[0].description).toBe('./scripts/pre-bash.sh');
			expect(hookItems[0].uri).toEqual(settingsUri);
		});

		it('uses wildcard label for * matcher', async () => {
			const workspaceFolder = URI.file('/workspace');
			mockWorkspaceService.setFolders([workspaceFolder]);
			mockFileSystemService.setFile(
				URI.joinPath(workspaceFolder, '.claude', 'settings.json'),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{ matcher: '*', hooks: [{ type: 'command', command: './init.sh' }] }
						]
					}
				})
			);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const hookItems = items.filter(i => i.type === FakeChatSessionCustomizationType.Hook);
			expect(hookItems).toHaveLength(1);
			expect(hookItems[0].name).toBe('SessionStart');
		});

		it('discovers hooks from user home .claude/settings.json', async () => {
			const userSettingsUri = URI.joinPath(URI.file('/home/user'), '.claude', 'settings.json');
			mockFileSystemService.setFile(userSettingsUri, JSON.stringify({
				hooks: {
					PostToolUse: [
						{ matcher: 'Edit', hooks: [{ type: 'command', command: './lint.sh' }] }
					]
				}
			}));

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const hookItems = items.filter(i => i.type === FakeChatSessionCustomizationType.Hook);
			expect(hookItems).toHaveLength(1);
			expect(hookItems[0].name).toBe('PostToolUse (Edit)');
		});

		it('discovers multiple hooks across event types', async () => {
			const workspaceFolder = URI.file('/workspace');
			mockWorkspaceService.setFolders([workspaceFolder]);
			mockFileSystemService.setFile(
				URI.joinPath(workspaceFolder, '.claude', 'settings.json'),
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{ matcher: 'Bash', hooks: [{ type: 'command', command: './a.sh' }] },
							{ matcher: 'Edit', hooks: [{ type: 'command', command: './b.sh' }, { type: 'command', command: './c.sh' }] },
						],
						SessionStart: [
							{ matcher: '*', hooks: [{ type: 'command', command: './init.sh' }] }
						]
					}
				})
			);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const hookItems = items.filter(i => i.type === FakeChatSessionCustomizationType.Hook);
			expect(hookItems).toHaveLength(4);
		});

		it('gracefully handles missing settings files', async () => {
			mockWorkspaceService.setFolders([URI.file('/workspace')]);
			// No files set in mock FS — all reads will throw

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('gracefully handles invalid JSON in settings', async () => {
			const workspaceFolder = URI.file('/workspace');
			mockWorkspaceService.setFolders([workspaceFolder]);
			mockFileSystemService.setFile(
				URI.joinPath(workspaceFolder, '.claude', 'settings.json'),
				'not valid json {'
			);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});
	});

	describe('onDidChange', () => {
		it('fires when custom agents change', () => {
			let fired = false;
			disposables.add(provider.onDidChange(() => { fired = true; }));

			mockPromptFileService.fireCustomAgentsChanged();
			expect(fired).toBe(true);
		});

		it('fires when instructions change', () => {
			let fired = false;
			disposables.add(provider.onDidChange(() => { fired = true; }));

			mockPromptFileService.fireInstructionsChanged();
			expect(fired).toBe(true);
		});

		it('fires when skills change', () => {
			let fired = false;
			disposables.add(provider.onDidChange(() => { fired = true; }));

			mockPromptFileService.fireSkillsChanged();
			expect(fired).toBe(true);
		});
	});
});
