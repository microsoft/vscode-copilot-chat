/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';

const vscodeMock = {
	Uri: {
		file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
	},
	workspace: {
		workspaceFolders: [],
		getWorkspaceFolder: () => undefined,
		getConfiguration: () => ({
			get: (_key: string, defaultValue: boolean) => defaultValue,
		}),
	},
};

vi.mock('vscode', () => vscodeMock);

const spawnMock = vi.fn();
vi.mock('child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { configureWorkspaceDeepSeekCriticApi, DEEPSEEK_CRITIC_HOOK_FILE, DEEPSEEK_CRITIC_RUNTIME_CONFIG_FILE, executeWorkspaceDeepSeekCriticHook, extractAdditionalContextFromHookStdout, inspectWorkspaceDeepSeekCriticHook, resolveWorkspaceDeepSeekCriticHook } from '../../node/workspaceDeepSeekCriticHook';

describe('workspaceDeepSeekCriticHook', () => {
	let tempDir: string | undefined;
	const originalWorkspaceFolders = (vscodeMock.workspace as any).workspaceFolders;
	const originalGetWorkspaceFolder = (vscodeMock.workspace as any).getWorkspaceFolder;

	beforeEach(() => {
		spawnMock.mockReset();
		configureWorkspaceDeepSeekCriticApi(vscodeMock.workspace as never);
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
		(vscodeMock.workspace as any).workspaceFolders = originalWorkspaceFolders;
		(vscodeMock.workspace as any).getWorkspaceFolder = originalGetWorkspaceFolder;
	});

	it('extracts additionalContext from hook stdout', () => {
		const stdout = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'UserPromptSubmit',
				additionalContext: 'critic output',
			},
		});
		expect(extractAdditionalContextFromHookStdout(stdout)).toBe('critic output');
	});

	it('resolves a workspace deepseek critic hook command from .copilot/hooks', async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'deepseek-critic-hook-'));
		const hooksDir = join(tempDir, '.copilot', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(tempDir, DEEPSEEK_CRITIC_HOOK_FILE), JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						matcher: '*',
						hooks: [
							{ type: 'command', command: 'python3 /tmp/deepseek-critic.py' },
						],
					},
				],
			},
		}), 'utf8');

		const workspaceFolder = { uri: vscodeMock.Uri.file(tempDir), name: 'tmp', index: 0 };
		(vscodeMock.workspace as any).workspaceFolders = [workspaceFolder];
		(vscodeMock.workspace as any).getWorkspaceFolder = () => workspaceFolder;

		const resolved = await resolveWorkspaceDeepSeekCriticHook();
		expect(resolved?.workspaceRoot).toBe(tempDir);
		expect(resolved?.command).toBe('python3 /tmp/deepseek-critic.py');
	});

	it('reports invalid hook json as an issue', async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'deepseek-critic-hook-'));
		const hooksDir = join(tempDir, '.copilot', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(tempDir, DEEPSEEK_CRITIC_HOOK_FILE), '{not json', 'utf8');

		const workspaceFolder = { uri: vscodeMock.Uri.file(tempDir), name: 'tmp', index: 0 };
		(vscodeMock.workspace as any).workspaceFolders = [workspaceFolder];
		(vscodeMock.workspace as any).getWorkspaceFolder = () => workspaceFolder;

		const inspection = await inspectWorkspaceDeepSeekCriticHook();
		expect(inspection.installed).toBe(true);
		expect(inspection.issue?.kind).toBe('invalid-config');
	});

	it('reports missing command as an issue', async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'deepseek-critic-hook-'));
		const hooksDir = join(tempDir, '.copilot', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(tempDir, DEEPSEEK_CRITIC_HOOK_FILE), JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						matcher: '*',
						hooks: [
							{ type: 'command' },
						],
					},
				],
			},
		}), 'utf8');

		const workspaceFolder = { uri: vscodeMock.Uri.file(tempDir), name: 'tmp', index: 0 };
		(vscodeMock.workspace as any).workspaceFolders = [workspaceFolder];
		(vscodeMock.workspace as any).getWorkspaceFolder = () => workspaceFolder;

		const inspection = await inspectWorkspaceDeepSeekCriticHook();
		expect(inspection.issue?.kind).toBe('missing-command');
	});

	it('reports invalid runtime config json as an issue', async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'deepseek-critic-hook-'));
		const hooksDir = join(tempDir, '.copilot', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(tempDir, DEEPSEEK_CRITIC_HOOK_FILE), JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						matcher: '*',
						hooks: [
							{ type: 'command', command: 'python3 /tmp/deepseek-critic.py' },
						],
					},
				],
			},
		}), 'utf8');
		writeFileSync(join(tempDir, DEEPSEEK_CRITIC_RUNTIME_CONFIG_FILE), '{oops', 'utf8');

		const workspaceFolder = { uri: vscodeMock.Uri.file(tempDir), name: 'tmp', index: 0 };
		(vscodeMock.workspace as any).workspaceFolders = [workspaceFolder];
		(vscodeMock.workspace as any).getWorkspaceFolder = () => workspaceFolder;

		const inspection = await inspectWorkspaceDeepSeekCriticHook();
		expect(inspection.issue?.kind).toBe('invalid-config');
		expect(inspection.issue?.message).toContain('runtime config');
	});

});
