/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SweCustomAgent } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../../common/chatPromptFileService';
import { ICopilotCLIAgents } from '../../copilotcli/node/copilotCli';
import { CopilotCLICustomizationProvider } from '../copilotCLICustomizationProvider';

class FakeChatSessionCustomizationType {
	static readonly Agent = new FakeChatSessionCustomizationType('agent');
	static readonly Skill = new FakeChatSessionCustomizationType('skill');
	static readonly Instructions = new FakeChatSessionCustomizationType('instructions');
	static readonly Prompt = new FakeChatSessionCustomizationType('prompt');
	static readonly Hook = new FakeChatSessionCustomizationType('hook');
	constructor(readonly id: string) { }
}

function makeSweAgent(name: string, description = '', displayName?: string): Readonly<SweCustomAgent> {
	return {
		name,
		displayName: displayName ?? name,
		description,
		tools: null,
		prompt: () => Promise.resolve(''),
		disableModelInvocation: false,
	};
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

class MockCopilotCLIAgents extends mock<ICopilotCLIAgents>() {
	private readonly _onDidChangeAgents = new Emitter<void>();
	override readonly onDidChangeAgents = this._onDidChangeAgents.event;
	private _agents: Readonly<SweCustomAgent>[] = [];

	setAgents(agents: Readonly<SweCustomAgent>[]) { this._agents = agents; }
	override async getAgents(): Promise<Readonly<SweCustomAgent>[]> { return this._agents; }
	fireAgentsChanged() { this._onDidChangeAgents.fire(); }
	dispose() { this._onDidChangeAgents.dispose(); }
}

class MockWorkspaceService extends mock<IWorkspaceService>() {
	private _folders: URI[] = [];
	setFolders(folders: URI[]) { this._folders = folders; }
	override getWorkspaceFolders(): URI[] { return this._folders; }
}

class MockEnvService extends mock<INativeEnvService>() {
	override userHome = URI.file('/home/user');
}

class TestLogService extends mock<ILogService>() {
	override trace() { }
	override debug() { }
}

const WORKSPACE = URI.file('/workspace');

describe('CopilotCLICustomizationProvider', () => {
	let disposables: DisposableStore;
	let mockPromptFileService: MockChatPromptFileService;
	let mockCopilotCLIAgents: MockCopilotCLIAgents;
	let mockWorkspaceService: MockWorkspaceService;
	let provider: CopilotCLICustomizationProvider;

	let originalChatSessionCustomizationType: unknown;

	beforeEach(() => {
		originalChatSessionCustomizationType = (vscode as Record<string, unknown>).ChatSessionCustomizationType;
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = FakeChatSessionCustomizationType;
		disposables = new DisposableStore();
		mockPromptFileService = disposables.add(new MockChatPromptFileService());
		mockCopilotCLIAgents = disposables.add(new MockCopilotCLIAgents());
		mockWorkspaceService = new MockWorkspaceService();
		mockWorkspaceService.setFolders([WORKSPACE]);
		provider = disposables.add(new CopilotCLICustomizationProvider(
			mockPromptFileService,
			mockCopilotCLIAgents,
			mockWorkspaceService,
			new MockEnvService(),
			new TestLogService(),
		));
	});

	afterEach(() => {
		disposables.dispose();
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = originalChatSessionCustomizationType;
	});

	describe('metadata', () => {
		it('has correct label and icon', () => {
			expect(CopilotCLICustomizationProvider.metadata.label).toBe('Copilot CLI');
			expect(CopilotCLICustomizationProvider.metadata.iconId).toBe('worktree');
		});

		it('marks Hook and Prompt types as unsupported', () => {
			const unsupported = CopilotCLICustomizationProvider.metadata.unsupportedTypes;
			expect(unsupported).toBeDefined();
			expect(unsupported).toHaveLength(2);
			expect(unsupported![0]).toBe(FakeChatSessionCustomizationType.Hook);
			expect(unsupported![1]).toBe(FakeChatSessionCustomizationType.Prompt);
		});
	});

	describe('provideChatSessionCustomizations', () => {
		it('returns empty array when no files exist', async () => {
			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('returns agents from ICopilotCLIAgents as primary source', async () => {
			mockCopilotCLIAgents.setAgents([
				makeSweAgent('explore', 'Fast code exploration'),
				makeSweAgent('task', 'Multi-step tasks'),
			]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(2);
			expect(agentItems[0].name).toBe('explore');
			expect(agentItems[0].description).toBe('Fast code exploration');
		});

		it('uses file URI when agent has matching .agent.md file', async () => {
			const fileUri = URI.file('/workspace/.github/explore.agent.md');
			mockPromptFileService.setCustomAgents([{ uri: fileUri }]);
			mockCopilotCLIAgents.setAgents([makeSweAgent('explore', 'Explore agent')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(1);
			expect(agentItems[0].uri).toEqual(fileUri);
			expect(agentItems[0].groupKey).toBeUndefined();
		});

		it('uses virtual URI for SDK-only agents without .agent.md files', async () => {
			mockCopilotCLIAgents.setAgents([makeSweAgent('task', 'Task agent')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(1);
			expect(agentItems[0].uri.scheme).toBe('copilotcli');
			expect(agentItems[0].uri.path).toBe('/agents/task');
			expect(agentItems[0].groupKey).toBe('Built-in');
		});

		it('uses displayName from SDK agents when available', async () => {
			mockCopilotCLIAgents.setAgents([makeSweAgent('code-review', 'Reviews code', 'Code Review')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items[0].name).toBe('Code Review');
		});

		it('returns instructions under .github/ paths', async () => {
			const uri = URI.file('/workspace/.github/copilot-instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('returns instructions under .copilot/ paths', async () => {
			const uri = URI.file('/workspace/.copilot/setup.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('returns instructions under .agents/ paths', async () => {
			const uri = URI.file('/workspace/.agents/setup.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('filters out instructions not under CLI paths', async () => {
			mockPromptFileService.setInstructions([
				{ uri: URI.file('/workspace/.claude/some.instructions.md') },
				{ uri: URI.file('/workspace/root.instructions.md') },
			]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(0);
		});

		it('returns skills under .github/skills/', async () => {
			const uri = URI.file('/workspace/.github/skills/lint-check/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
			expect(items[0].name).toBe('lint-check');
		});

		it('returns skills under .copilot/skills/', async () => {
			const uri = URI.file('/workspace/.copilot/skills/my-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('my-skill');
		});

		it('returns skills under .agents/skills/', async () => {
			const uri = URI.file('/workspace/.agents/skills/agent-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('agent-skill');
		});

		it('filters out skills not under CLI paths', async () => {
			mockPromptFileService.setSkills([
				{ uri: URI.file('/workspace/.claude/skills/claude-skill/SKILL.md') },
			]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(0);
		});

		it('includes instructions from home directory ~/.copilot/', async () => {
			const uri = URI.file('/home/user/.copilot/custom.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('includes skills from home directory ~/.agents/', async () => {
			const uri = URI.file('/home/user/.agents/skills/personal/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
		});

		it('returns all matching types combined', async () => {
			mockCopilotCLIAgents.setAgents([makeSweAgent('explore', 'Explore')]);
			mockPromptFileService.setInstructions([{ uri: URI.file('/workspace/.github/b.instructions.md') }]);
			mockPromptFileService.setSkills([{ uri: URI.file('/workspace/.github/skills/c/SKILL.md') }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(3);
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

		it('fires when ICopilotCLIAgents agents change', () => {
			let fired = false;
			disposables.add(provider.onDidChange(() => { fired = true; }));

			mockCopilotCLIAgents.fireAgentsChanged();
			expect(fired).toBe(true);
		});
	});
});
