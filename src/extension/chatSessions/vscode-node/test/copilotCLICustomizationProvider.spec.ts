/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SweCustomAgent } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IChatPromptFileService } from '../../common/chatPromptFileService';
import { CLIAgentInfo, ICopilotCLIAgents } from '../../copilotcli/node/copilotCli';
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

/** Creates a CLIAgentInfo with a synthetic copilotcli: URI (SDK-only agent). */
function makeAgentInfo(name: string, description = '', displayName?: string): CLIAgentInfo {
	return {
		agent: makeSweAgent(name, description, displayName),
		sourceUri: URI.from({ scheme: 'copilotcli', path: `/agents/${name}` }),
	};
}

/** Creates a CLIAgentInfo with a file: URI (prompt-file-backed agent). */
function makeFileAgentInfo(name: string, fileUri: URI, description = ''): CLIAgentInfo {
	return {
		agent: makeSweAgent(name, description),
		sourceUri: fileUri,
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
	private _agents: CLIAgentInfo[] = [];

	setAgents(agents: CLIAgentInfo[]) { this._agents = agents; }
	override async getAgents(): Promise<readonly CLIAgentInfo[]> { return this._agents; }
	fireAgentsChanged() { this._onDidChangeAgents.fire(); }
	dispose() { this._onDidChangeAgents.dispose(); }
}

class TestLogService extends mock<ILogService>() {
	override trace() { }
	override debug() { }
}

describe('CopilotCLICustomizationProvider', () => {
	let disposables: DisposableStore;
	let mockPromptFileService: MockChatPromptFileService;
	let mockCopilotCLIAgents: MockCopilotCLIAgents;
	let provider: CopilotCLICustomizationProvider;

	let originalChatSessionCustomizationType: unknown;

	beforeEach(() => {
		originalChatSessionCustomizationType = (vscode as Record<string, unknown>).ChatSessionCustomizationType;
		(vscode as Record<string, unknown>).ChatSessionCustomizationType = FakeChatSessionCustomizationType;
		disposables = new DisposableStore();
		mockPromptFileService = disposables.add(new MockChatPromptFileService());
		mockCopilotCLIAgents = disposables.add(new MockCopilotCLIAgents());
		provider = disposables.add(new CopilotCLICustomizationProvider(
			mockPromptFileService,
			mockCopilotCLIAgents,
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

		it('supports Agent, Skill, and Instructions types', () => {
			const supported = CopilotCLICustomizationProvider.metadata.supportedTypes;
			expect(supported).toBeDefined();
			expect(supported).toHaveLength(3);
			expect(supported).toContain(FakeChatSessionCustomizationType.Agent);
			expect(supported).toContain(FakeChatSessionCustomizationType.Skill);
			expect(supported).toContain(FakeChatSessionCustomizationType.Instructions);
		});

		it('only returns items whose type is in supportedTypes', async () => {
			mockCopilotCLIAgents.setAgents([makeAgentInfo('explore', 'Explore')]);
			const items = await provider.provideChatSessionCustomizations(undefined!);
			const supported = new Set(CopilotCLICustomizationProvider.metadata.supportedTypes!.map(t => t.id));
			for (const item of items) {
				expect(supported.has(item.type.id), `item "${item.name}" has type "${item.type.id}" not in supportedTypes`).toBe(true);
			}
		});

		it('does not set groupKey for items with synthetic URIs (vscode infers grouping)', async () => {
			mockCopilotCLIAgents.setAgents([makeAgentInfo('explore', 'Explore')]);
			const items = await provider.provideChatSessionCustomizations(undefined!);
			const builtinItems = items.filter(i => i.uri.scheme !== 'file');
			for (const item of builtinItems) {
				expect(item.groupKey, `item "${item.name}" should not have groupKey (vscode infers)`).toBeUndefined();
			}
		});
	});

	describe('provideChatSessionCustomizations', () => {
		it('returns empty array when no files exist', async () => {
			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toEqual([]);
		});

		it('returns agents from ICopilotCLIAgents with source URIs', async () => {
			mockCopilotCLIAgents.setAgents([
				makeAgentInfo('explore', 'Fast code exploration'),
				makeAgentInfo('task', 'Multi-step tasks'),
			]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(2);
			expect(agentItems[0].name).toBe('explore');
			expect(agentItems[0].description).toBe('Fast code exploration');
		});

		it('uses file URI from sourceUri for file-backed agents', async () => {
			const fileUri = URI.file('/workspace/.github/explore.agent.md');
			mockCopilotCLIAgents.setAgents([makeFileAgentInfo('explore', fileUri, 'Explore agent')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(1);
			expect(agentItems[0].uri).toEqual(fileUri);
			expect(agentItems[0].groupKey).toBeUndefined();
		});

		it('uses synthetic URI for SDK-only agents', async () => {
			mockCopilotCLIAgents.setAgents([makeAgentInfo('task', 'Task agent')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			const agentItems = items.filter((i: vscode.ChatSessionCustomizationItem) => i.type === FakeChatSessionCustomizationType.Agent);
			expect(agentItems).toHaveLength(1);
			expect(agentItems[0].uri.scheme).toBe('copilotcli');
			expect(agentItems[0].uri.path).toBe('/agents/task');
			expect(agentItems[0].groupKey).toBeUndefined();
		});

		it('uses displayName from agents when available', async () => {
			mockCopilotCLIAgents.setAgents([makeAgentInfo('code-review', 'Reviews code', 'Code Review')]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items[0].name).toBe('Code Review');
		});

		it('returns instructions', async () => {
			const uri = URI.file('/workspace/.github/copilot-instructions.md');
			mockPromptFileService.setInstructions([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Instructions);
		});

		it('returns skills', async () => {
			const uri = URI.file('/workspace/.github/skills/lint-check/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].uri).toBe(uri);
			expect(items[0].type).toBe(FakeChatSessionCustomizationType.Skill);
			expect(items[0].name).toBe('lint-check');
		});

		it('derives skill name from parent directory for SKILL.md files', async () => {
			const uri = URI.file('/workspace/.copilot/skills/my-skill/SKILL.md');
			mockPromptFileService.setSkills([{ uri }]);

			const items = await provider.provideChatSessionCustomizations(undefined!);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('my-skill');
		});

		it('returns all matching types combined', async () => {
			mockCopilotCLIAgents.setAgents([makeAgentInfo('explore', 'Explore')]);
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
