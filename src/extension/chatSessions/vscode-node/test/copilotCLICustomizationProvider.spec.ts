/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { mock } from '../../../../util/common/test/simpleMock';
import { IChatPromptFileService } from '../../common/chatPromptFileService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CopilotCLICustomizationProvider } from '../copilotCLICustomizationProvider';

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

class TestLogService extends mock<ILogService>() {
	override trace() { }
}

const WORKSPACE = URI.file('/workspace');

describe('CopilotCLICustomizationProvider', () => {
	let disposables: DisposableStore;
	let mockPromptFileService: MockChatPromptFileService;
	let mockWorkspaceService: MockWorkspaceService;
	let provider: CopilotCLICustomizationProvider;

	beforeEach(() => {
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = FakeChatSessionCustomizationType;
		disposables = new DisposableStore();
		mockPromptFileService = disposables.add(new MockChatPromptFileService());
		mockWorkspaceService = new MockWorkspaceService();
		mockWorkspaceService.setFolders([WORKSPACE]);
		provider = disposables.add(new CopilotCLICustomizationProvider(
			mockPromptFileService,
			mockWorkspaceService,
			new TestLogService(),
		));
	});

	afterEach(() => {
		disposables.dispose();
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

		it('does not expose workspaceSubpaths', () => {
			expect('workspaceSubpaths' in CopilotCLICustomizationProvider.metadata).toBe(false);
		});
	});

	describe('provideChatSessionCustomizations', () => {
		it('returns empty array when no files exist', () => {
			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('returns all agents regardless of path', () => {
			mockPromptFileService.setCustomAgents([
				{ uri: URI.file('/workspace/.github/my-agent.agent.md') },
				{ uri: URI.file('/workspace/root-agent.agent.md') },
				{ uri: URI.file('/other/path/agent.agent.md') },
			]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(3);
			expect(items.every(i => i.type === FakeChatSessionCustomizationType.Agent)).toBe(true);
		});

		it('returns instructions under .github/ paths', () => {
			const uri = URI.file('/workspace/.github/copilot-instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('returns instructions under .copilot/ paths', () => {
			const uri = URI.file('/workspace/.copilot/setup.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('filters out instructions not under .github/ or .copilot/', () => {
			mockPromptFileService.setInstructions([
				{ uri: URI.file('/workspace/.claude/some.instructions.md') },
				{ uri: URI.file('/workspace/root.instructions.md') },
			]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(0);
		});

		it('returns skills under .github/skills/', () => {
			const uri = URI.file('/workspace/.github/skills/lint-check/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
			expect(items[0].name).toBe('lint-check');
		});

		it('returns skills under .copilot/skills/', () => {
			const uri = URI.file('/workspace/.copilot/skills/my-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('my-skill');
		});

		it('filters out skills not under .github/ or .copilot/', () => {
			mockPromptFileService.setSkills([
				{ uri: URI.file('/workspace/.claude/skills/claude-skill/SKILL.md') },
			]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(0);
		});

		it('returns all matching types combined', () => {
			mockPromptFileService.setCustomAgents([{ uri: URI.file('/workspace/a.agent.md') }]);
			mockPromptFileService.setInstructions([{ uri: URI.file('/workspace/.github/b.instructions.md') }]);
			mockPromptFileService.setSkills([{ uri: URI.file('/workspace/.github/skills/c/SKILL.md') }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
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
	});
});
