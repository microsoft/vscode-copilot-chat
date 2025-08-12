/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { ILogService } from '../../../../platform/log/common/logService';
import { AbortError, ClaudeCodeProps, SDKMessage } from '../../common/claudeCodeSdk';
import { LanguageModelServer } from '../../vscode-node/langModelServer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';

const useNode = true;
const ClaudeExecutable = 'claude';

// TODO import and invoke sdk
export class ClaudeCodeInvoker {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	public async *query({
		prompt,
		options: {
			abortController = new AbortController(),
			allowedTools = [],
			appendSystemPrompt,
			customSystemPrompt,
			cwd,
			disallowedTools = [],
			maxTurns,
			mcpServers,
			permissionMode = 'default',
			permissionPromptToolName,
			continue: continueConversation,
			resume,
			model,
			fallbackModel
		} = {}
	}: ClaudeCodeProps): AsyncGenerator<SDKMessage> {
		if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
			process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
		}

		// Start the LanguageModelServer
		const languageModelServer = this.instantiationService.createInstance(LanguageModelServer);
		await languageModelServer.start();
		const serverConfig = languageModelServer.getConfig();

		const args: string[] = ['--output-format', 'stream-json', '--verbose'];

		if (customSystemPrompt) {
			args.push('--system-prompt', customSystemPrompt);
		}
		if (appendSystemPrompt) {
			args.push('--append-system-prompt', appendSystemPrompt);
		}
		if (maxTurns) {
			args.push('--max-turns', maxTurns.toString());
		}
		if (model) {
			args.push('--model', model);
		}
		if (permissionPromptToolName) {
			args.push('--permission-prompt-tool', permissionPromptToolName);
		}
		if (continueConversation) {
			args.push('--continue');
		}
		if (resume) {
			args.push('--resume', resume);
		}
		if (allowedTools.length > 0) {
			args.push('--allowedTools', allowedTools.join(','));
		}
		if (disallowedTools.length > 0) {
			args.push('--disallowedTools', disallowedTools.join(','));
		}
		if (mcpServers && Object.keys(mcpServers).length > 0) {
			args.push('--mcp-config', JSON.stringify({ mcpServers }));
		}
		if (permissionMode !== 'default') {
			args.push('--permission-mode', permissionMode);
		}
		if (fallbackModel) {
			if (model && fallbackModel === model) {
				throw new Error('Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.');
			}
			args.push('--fallback-model', fallbackModel);
		}

		if (!prompt.trim()) {
			throw new RangeError('Prompt is required');
		}
		args.push('--print', prompt.trim());

		const lmServerEnv = {
			// Pass LanguageModelServer config to the spawned process
			ANTHROPIC_BASE_URL: `http://localhost:${serverConfig.port}`,
			ANTHROPIC_API_KEY: serverConfig.nonce
		};

		const exe = useNode ? 'node' : ClaudeExecutable;
		const useArgs = useNode ? ['/Users/roblou/code/claude-code/sdk.mjs', ...args] : args;

		this.logService.debug(`Spawning Claude Code process: ${[exe, ...useArgs].join(' ')}\nwith env: ${JSON.stringify(lmServerEnv)}`);

		const child = spawn(exe, useArgs, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			signal: abortController.signal,
			env: {
				...process.env,
				...lmServerEnv
			}
		});

		child.stdin.end();

		if (process.env.DEBUG) {
			child.stderr.on('data', (data: Buffer) => {
				this.logService.error('Claude Code stderr:', data.toString());
			});
		}

		const cleanup = (): void => {
			if (!child.killed) {
				child.kill('SIGTERM');
			}
			// Stop the language model server
			languageModelServer.stop();
		};

		abortController.signal.addEventListener('abort', cleanup);
		process.on('exit', cleanup);

		try {
			let processError: Error | null = null;

			child.on('error', (error: Error) => {
				processError = new Error(`Failed to spawn Claude Code process: ${error.message}`);
			});

			const processExitPromise = new Promise<void>((resolve, reject) => {
				child.on('close', (code: number | null) => {
					if (abortController.signal.aborted) {
						reject(new AbortError('Claude Code process aborted by user'));
					}
					if (code !== 0) {
						reject(new Error(`Claude Code process exited with code ${code}`));
					} else {
						resolve();
					}
				});
			});

			const rl = createInterface({ input: child.stdout });

			try {
				for await (const line of rl) {
					if (processError) {
						throw processError;
					}
					if (line.trim()) {
						yield JSON.parse(line) as SDKMessage;
					}
				}
			} finally {
				rl.close();
			}

			await processExitPromise;
		} finally {
			cleanup();
			abortController.signal.removeEventListener('abort', cleanup);
			if (process.env.CLAUDE_SDK_MCP_SERVERS) {
				delete process.env.CLAUDE_SDK_MCP_SERVERS;
			}
		}
	}
}
