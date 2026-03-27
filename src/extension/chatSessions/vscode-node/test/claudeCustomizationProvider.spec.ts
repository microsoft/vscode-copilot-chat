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

class TestLogService extends mock<ILogService>() {
	override trace() { }
}

describe('ClaudeCustomizationProvider', () => {
	let disposables: DisposableStore;
	let mockPromptFileService: MockChatPromptFileService;
	let provider: ClaudeCustomizationProvider;

	beforeEach(() => {
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = FakeChatSessionCustomizationType;
		disposables = new DisposableStore();
		mockPromptFileService = disposables.add(new MockChatPromptFileService());
		provider = disposables.add(new ClaudeCustomizationProvider(
			mockPromptFileService,
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
		it('returns empty array when no files exist', () => {
			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('returns agents with Agent type', () => {
			const uri = URI.file('/workspace/.claude/my-helper.agent.md');
			mockPromptFileService.setCustomAgents([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Agent);
			expect(items[0].name).toBe('my-helper');
		});

		it('returns instructions with Instructions type', () => {
			const uri = URI.file('/workspace/.claude/setup.instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
			expect(items[0].name).toBe('setup');
		});

		it('returns skills with Skill type and derives name from parent dir', () => {
			const uri = URI.file('/workspace/.claude/skills/my-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
			expect(items[0].name).toBe('my-skill');
		});

		it('returns all types combined', () => {
			mockPromptFileService.setCustomAgents([{ uri: URI.file('/a.agent.md') }]);
			mockPromptFileService.setInstructions([{ uri: URI.file('/b.instructions.md') }]);
			mockPromptFileService.setSkills([{ uri: URI.file('/skills/c/SKILL.md') }]);

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
