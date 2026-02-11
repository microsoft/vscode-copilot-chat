/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { homedir } from 'os';
import type { CancellationToken, ChatHookCommand, Uri } from 'vscode';
import { ILogService } from '../../log/common/logService';
import { HookCommandResultKind, IHookCommandResult, IHookExecutor } from '../common/hookExecutor';

const SIGKILL_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_SEC = 30;

export class NodeHookExecutor implements IHookExecutor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService
	) { }

	async executeCommand(
		hookCommand: ChatHookCommand,
		input: unknown,
		token: CancellationToken
	): Promise<IHookCommandResult> {
		this._logService.debug(`[HookExecutor] Running hook command: ${hookCommand.command}`);

		try {
			return await this._spawn(hookCommand, input, token);
		} catch (err) {
			// Spawn failures (e.g. command not found) are non-blocking warnings
			return {
				kind: HookCommandResultKind.NonBlockingError,
				result: err instanceof Error ? err.message : String(err)
			};
		}
	}

	private _spawn(hook: ChatHookCommand, input: unknown, token: CancellationToken): Promise<IHookCommandResult> {
		const cwd = hook.cwd ? uriToFsPath(hook.cwd) : homedir();

		const child = spawn(hook.command, [], {
			stdio: 'pipe',
			cwd,
			env: { ...process.env, ...hook.env },
			shell: true,
		});

		return new Promise((resolve, reject) => {
			const stdout: string[] = [];
			const stderr: string[] = [];
			let exitCode: number | null = null;
			let exited = false;

			let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
			let tokenListener: { dispose(): void } | undefined;

			const killWithEscalation = () => {
				if (exited) {
					return;
				}
				child.kill('SIGTERM');
				sigkillTimer = setTimeout(() => {
					if (!exited) {
						child.kill('SIGKILL');
					}
				}, SIGKILL_DELAY_MS);
			};

			const cleanup = () => {
				exited = true;
				if (sigkillTimer) {
					clearTimeout(sigkillTimer);
				}
				clearTimeout(timeoutTimer);
				tokenListener?.dispose();
			};

			// Collect output
			child.stdout.on('data', data => stdout.push(data.toString()));
			child.stderr.on('data', data => stderr.push(data.toString()));

			// Set up timeout
			const timeoutTimer = setTimeout(killWithEscalation, (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000);

			// Set up cancellation
			if (token) {
				tokenListener = token.onCancellationRequested(killWithEscalation);
			}

			// Write input to stdin
			if (input !== undefined && input !== null) {
				try {
					child.stdin.write(JSON.stringify(input, (_key, value) => {
						// Convert URI-like objects to filesystem paths
						if (isUriLike(value)) {
							return uriToFsPath(value);
						}
						return value;
					}));
				} catch {
					// Ignore stdin write errors
				}
			}
			child.stdin.end();

			// Capture exit code
			child.on('exit', code => { exitCode = code; });

			// Resolve on close (after streams flush)
			child.on('close', () => {
				cleanup();
				const code = exitCode ?? 1;
				const stdoutStr = stdout.join('');
				const stderrStr = stderr.join('');

				if (code === 0) {
					let result: string | object = stdoutStr;
					try {
						result = JSON.parse(stdoutStr);
					} catch {
						// Keep as string if not valid JSON
					}
					resolve({ kind: HookCommandResultKind.Success, result });
				} else if (code === 2) {
					// Exit code 2: blocking error shown to model
					resolve({ kind: HookCommandResultKind.Error, result: stderrStr });
				} else {
					// Other non-zero: non-blocking warning shown to user only
					resolve({ kind: HookCommandResultKind.NonBlockingError, result: stderrStr });
				}
			});

			child.on('error', err => {
				cleanup();
				reject(err);
			});
		});
	}
}

function isUriLike(value: unknown): value is Uri {
	return typeof value === 'object' && value !== null && 'scheme' in value && 'path' in value;
}

function uriToFsPath(uri: Uri): string {
	// vscode.Uri has an fsPath getter
	if ('fsPath' in uri && typeof uri.fsPath === 'string') {
		return uri.fsPath;
	}
	// Fallback for URI-like objects
	return (uri as { path: string }).path;
}
