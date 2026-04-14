/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';

export const DEEPSEEK_CRITIC_HOOK_FILE = '.copilot/hooks/deepseek-critic.json';
export const DEEPSEEK_CRITIC_RUNTIME_CONFIG_FILE = '.copilot/hooks/deepseek-critic.config.json';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEEPSEEK_CRITIC_ENABLED_SETTING = 'deepseekCritic.enabled';

type DeepSeekCriticWorkspaceApi = Pick<typeof import('vscode').workspace, 'workspaceFolders' | 'getWorkspaceFolder' | 'getConfiguration'>;

let workspaceApi: DeepSeekCriticWorkspaceApi = {
	workspaceFolders: [],
	getWorkspaceFolder: () => undefined,
	getConfiguration: () => ({
		get: (_key: string, defaultValue: boolean) => defaultValue,
	}) as ReturnType<typeof import('vscode').workspace.getConfiguration>,
};

export function configureWorkspaceDeepSeekCriticApi(api: DeepSeekCriticWorkspaceApi): void {
	workspaceApi = api;
}

interface HookConfig {
	readonly type?: string;
	readonly command?: string;
	readonly timeout?: number;
}

interface MatcherConfig {
	readonly matcher?: string;
	readonly hooks?: readonly HookConfig[];
}

interface WorkspaceHookDefinition {
	readonly hooks?: {
		readonly UserPromptSubmit?: readonly MatcherConfig[];
	};
}

export interface ResolvedDeepSeekCriticHook {
	readonly workspaceRoot: string;
	readonly configPath: string;
	readonly command: string;
	readonly timeoutMs: number;
}

export type DeepSeekCriticHookIssueKind =
	| 'invalid-config'
	| 'missing-command'
	| 'spawn-error'
	| 'non-zero-exit'
	| 'timeout'
	| 'no-context';

export interface DeepSeekCriticHookIssue {
	readonly kind: DeepSeekCriticHookIssueKind;
	readonly message: string;
	readonly workspaceRoot?: string;
	readonly configPath?: string;
}

export interface DeepSeekCriticHookInspection {
	readonly workspaceRoot?: string;
	readonly configPath?: string;
	readonly runtimeConfigPath?: string;
	readonly installed: boolean;
	readonly resolved?: ResolvedDeepSeekCriticHook;
	readonly issue?: DeepSeekCriticHookIssue;
}

export interface DeepSeekCriticHookExecutionResult {
	readonly additionalContext?: string;
	readonly issue?: DeepSeekCriticHookIssue;
}

function getWorkspaceFolder(activeResource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
	return activeResource
		? workspaceApi.getWorkspaceFolder(activeResource) ?? workspaceApi.workspaceFolders?.[0]
		: workspaceApi.workspaceFolders?.[0];
}

export function isWorkspaceDeepSeekCriticEnabled(): boolean {
	return workspaceApi.getConfiguration('github.copilot.chat').get<boolean>(DEEPSEEK_CRITIC_ENABLED_SETTING, true);
}

function createIssue(
	kind: DeepSeekCriticHookIssueKind,
	message: string,
	workspaceRoot?: string,
	configPath?: string,
): DeepSeekCriticHookIssue {
	return { kind, message, workspaceRoot, configPath };
}

export async function inspectWorkspaceDeepSeekCriticHook(activeResource?: vscode.Uri): Promise<DeepSeekCriticHookInspection> {
	if (!isWorkspaceDeepSeekCriticEnabled()) {
		return { installed: false };
	}

	const workspaceFolder = getWorkspaceFolder(activeResource);
	if (!workspaceFolder) {
		return { installed: false };
	}

	const workspaceRoot = workspaceFolder.uri.fsPath;
	const configPath = join(workspaceRoot, DEEPSEEK_CRITIC_HOOK_FILE);
	const runtimeConfigPath = join(workspaceRoot, DEEPSEEK_CRITIC_RUNTIME_CONFIG_FILE);
	if (!existsSync(configPath)) {
		return { installed: false, workspaceRoot, configPath, runtimeConfigPath };
	}

	let parsed: WorkspaceHookDefinition | undefined;
	try {
		parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as WorkspaceHookDefinition;
	} catch {
		return {
			installed: true,
			workspaceRoot,
			configPath,
			runtimeConfigPath,
			issue: createIssue('invalid-config', 'DeepSeek critic hook JSON is invalid.', workspaceRoot, configPath),
		};
	}

	const commandEntry = parsed.hooks?.UserPromptSubmit
		?.flatMap(matcher => matcher.hooks ?? [])
		.find(hook => hook.type === 'command' && !!hook.command);

	if (!commandEntry?.command) {
		return {
			installed: true,
			workspaceRoot,
			configPath,
			runtimeConfigPath,
			issue: createIssue('missing-command', 'DeepSeek critic hook command is missing.', workspaceRoot, configPath),
		};
	}

	if (existsSync(runtimeConfigPath)) {
		try {
			JSON.parse(await fs.readFile(runtimeConfigPath, 'utf8')) as Record<string, unknown>;
		} catch {
			return {
				installed: true,
				workspaceRoot,
				configPath,
				runtimeConfigPath,
				issue: createIssue('invalid-config', 'DeepSeek critic runtime config JSON is invalid.', workspaceRoot, runtimeConfigPath),
			};
		}
	}

	return {
		installed: true,
		workspaceRoot,
		configPath,
		runtimeConfigPath,
		resolved: {
			workspaceRoot,
			configPath,
			command: commandEntry.command,
			timeoutMs: Math.max(1, commandEntry.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
		},
	};
}

export async function resolveWorkspaceDeepSeekCriticHook(activeResource?: vscode.Uri): Promise<ResolvedDeepSeekCriticHook | undefined> {
	return (await inspectWorkspaceDeepSeekCriticHook(activeResource)).resolved;
}

export function extractAdditionalContextFromHookStdout(stdout: string): string | undefined {
	if (!stdout.trim()) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(stdout);
		const ctx = parsed?.hookSpecificOutput?.additionalContext;
		return typeof ctx === 'string' && ctx.trim().length > 0 ? ctx : undefined;
	} catch {
		return undefined;
	}
}

export async function executeWorkspaceDeepSeekCriticHook(
	prompt: string,
	logService: ILogService,
	activeResource?: vscode.Uri,
): Promise<DeepSeekCriticHookExecutionResult> {
	const inspection = await inspectWorkspaceDeepSeekCriticHook(activeResource);
	if (inspection.issue) {
		logService.debug(`[DeepSeekCritic] ${inspection.issue.message}`);
		return { issue: inspection.issue };
	}

	const resolved = inspection.resolved;
	if (!resolved) {
		return {};
	}

	return new Promise<DeepSeekCriticHookExecutionResult>((resolve) => {
		const proc = spawn(resolved.command, [], {
			cwd: resolved.workspaceRoot,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: true,
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const settle = (value: DeepSeekCriticHookExecutionResult) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		const timer = setTimeout(() => {
			try {
				proc.kill('SIGTERM');
			} catch {
				// ignore
			}
			logService.debug(`[DeepSeekCritic] Hook timed out after ${resolved.timeoutMs}ms (${resolved.configPath})`);
			settle({
				issue: createIssue('timeout', 'DeepSeek critic hook timed out.', resolved.workspaceRoot, resolved.configPath),
			});
		}, resolved.timeoutMs);

		proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
		proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

		proc.on('close', (code: number | null) => {
			clearTimeout(timer);

			if (code !== 0) {
				logService.debug(`[DeepSeekCritic] Hook exited with code ${code}: ${stderr.trim()}`);
				settle({
					issue: createIssue('non-zero-exit', `DeepSeek critic hook exited with code ${code}.`, resolved.workspaceRoot, resolved.configPath),
				});
				return;
			}

			const ctx = extractAdditionalContextFromHookStdout(stdout);
			if (!ctx && stderr.trim()) {
				logService.debug(`[DeepSeekCritic] Hook returned no context: ${stderr.trim()}`);
				settle({
					issue: createIssue('no-context', stderr.trim(), resolved.workspaceRoot, resolved.configPath),
				});
				return;
			}
			if (!ctx) {
				settle({
					issue: createIssue('no-context', 'DeepSeek critic hook returned no additional context.', resolved.workspaceRoot, resolved.configPath),
				});
				return;
			}
			settle({ additionalContext: ctx });
		});

		proc.on('error', (err: Error) => {
			clearTimeout(timer);
			logService.debug(`[DeepSeekCritic] Hook spawn error: ${err.message}`);
			settle({
				issue: createIssue('spawn-error', `DeepSeek critic hook failed to start: ${err.message}`, resolved.workspaceRoot, resolved.configPath),
			});
		});

		const payload: Record<string, string> = {
			prompt,
			workspaceRoot: resolved.workspaceRoot,
		};
		if (activeResource?.scheme === 'file') {
			payload.activeFile = activeResource.fsPath;
		}
		proc.stdin.write(JSON.stringify(payload));
		proc.stdin.end();
	});
}
