/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEnvService, OperatingSystem } from '../../../../platform/env/common/envService';
import { ISimulationTestContext } from '../../../../platform/simulationTestContext/common/simulationTestContext';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { PreparedTerminalToolInvocation, type MarkdownString } from '../../../../vscodeTypes';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { CopilotToolMode } from '../../common/toolsRegistry';
import { IRunInTerminalParams, RunInTerminalTool } from '../runInTerminalTool';
import type { CommandLineAutoApprover } from '../toolUtils.terminal';

class TestRunInTerminalTool extends RunInTerminalTool {
	get commandLineAutoApprover(): CommandLineAutoApprover { return this._commandLineAutoApprover; }

	async rewriteCommandIfNeeded(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParams>): Promise<string> {
		return this._rewriteCommandIfNeeded(options);
	}
}

describe('RunInTerminalTool', () => {
	let store: DisposableStore;
	let instantiationService: IInstantiationService;
	let configurationService: IConfigurationService;
	let envService: IEnvService;
	let simulationTestContext: ISimulationTestContext;
	let workspaceService: IWorkspaceService;
	let runInTerminalTool: TestRunInTerminalTool;

	beforeEach(() => {
		store = new DisposableStore();

		const accessor = store.add(createExtensionUnitTestingServices()).createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		configurationService = accessor.get(IConfigurationService);
		envService = accessor.get(IEnvService);
		simulationTestContext = accessor.get(ISimulationTestContext);
		workspaceService = accessor.get(IWorkspaceService);

		runInTerminalTool = store.add(instantiationService.createInstance(TestRunInTerminalTool));
	});

	afterEach(() => {
		store.dispose();
	});

	// Helper functions shared across test suites
	function createMockOptions(params: Partial<IRunInTerminalParams> = {}): vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParams> {
		return {
			input: {
				command: 'echo hello',
				explanation: 'Print hello to the console',
				isBackground: false,
				...params
			}
		};
	}

	function createMockPromptContext(): IBuildPromptContext {
		return {
			tools: {
				toolInvocationToken: 'test-token' as any,
				toolReferences: [],
				availableTools: []
			}
		} as any;
	}

	/**
	 * Sets up the configuration with allow and deny lists
	 */
	function setupConfiguration(allowList: string[] = [], denyList: string[] = []) {
		const allowListObject: { [key: string]: boolean } = {};
		for (const entry of allowList) {
			allowListObject[entry] = true;
		}
		const denyListObject: { [key: string]: boolean } = {};
		for (const entry of denyList) {
			denyListObject[entry] = true;
		}
		configurationService.setConfig(ConfigKey.TerminalAllowList, allowListObject);
		configurationService.setConfig(ConfigKey.TerminalDenyList, denyListObject);
		runInTerminalTool.commandLineAutoApprover.updateConfiguration();
	}

	/**
	 * Executes a test scenario for the RunInTerminalTool
	 */
	async function executeToolTest(
		params: Partial<IRunInTerminalParams>,
		promptContext = createMockPromptContext()
	): Promise<PreparedTerminalToolInvocation> {
		const options = createMockOptions(params);
		await runInTerminalTool.resolveInput(options.input, promptContext, CopilotToolMode.FullContext);
		const result = await runInTerminalTool.prepareInvocation2(options, {} as any);

		expect(result).toBeInstanceOf(PreparedTerminalToolInvocation);
		return result as PreparedTerminalToolInvocation;
	}

	/**
	 * Helper to assert that a command should be auto-approved (no confirmation required)
	 */
	function assertAutoApproved(preparedInvocation: PreparedTerminalToolInvocation) {
		expect(preparedInvocation.confirmationMessages).toBeUndefined();
	}

	/**
	 * Helper to assert that a command requires confirmation
	 */
	function assertConfirmationRequired(preparedInvocation: PreparedTerminalToolInvocation, expectedTitle?: string) {
		expect(preparedInvocation.confirmationMessages).toBeDefined();
		if (expectedTitle) {
			expect(preparedInvocation.confirmationMessages!.title).toBe(expectedTitle);
		}
	}

	function getMessageContent(message: string | MarkdownString): string {
		if (typeof message === 'string') {
			return message;
		}
		return message.value;
	}

	describe('prepareInvocation2 - auto approval behavior', () => {

		it('should auto-approve commands in allow list', async () => {
			setupConfiguration(['echo']);

			const result = await executeToolTest({ command: 'echo hello world' });
			assertAutoApproved(result);
			expect(result.command).toBe('echo hello world');
		});

		it('should require confirmation for commands not in allow list', async () => {
			setupConfiguration(['ls']);

			const result = await executeToolTest({
				command: 'rm file.txt',
				explanation: 'Remove a file'
			});
			assertConfirmationRequired(result, 'Run command in terminal');
			expect(getMessageContent(result.confirmationMessages!.message)).toBe('Remove a file');
		});

		it('should require confirmation for commands in deny list even if in allow list', async () => {
			setupConfiguration(['rm', 'echo'], ['rm']);

			assertConfirmationRequired(await executeToolTest({
				command: 'rm dangerous-file.txt',
				explanation: 'Remove a dangerous file'
			}), 'Run command in terminal');
		});

		it('should handle background commands with confirmation', async () => {
			setupConfiguration(['ls']);

			assertConfirmationRequired(await executeToolTest({
				command: 'npm run watch',
				explanation: 'Start watching for file changes',
				isBackground: true
			}), 'Run command in background terminal');
		});

		it('should auto-approve background commands in allow list', async () => {
			setupConfiguration(['npm']);

			assertAutoApproved(await executeToolTest({
				command: 'npm run watch',
				explanation: 'Start watching for file changes',
				isBackground: true
			}));
		});

		it('should handle regex patterns in allow list', async () => {
			setupConfiguration(['/^git (status|log)/']);

			assertAutoApproved(await executeToolTest({ command: 'git status --porcelain' }));
		});

		it('should handle complex command chains with sub-commands', async () => {
			setupConfiguration(['echo', 'ls']);

			assertAutoApproved(await executeToolTest({ command: 'echo "hello" && ls -la' }));
		});

		it('should require confirmation when one sub-command is not approved', async () => {
			setupConfiguration(['echo']);

			assertConfirmationRequired(await executeToolTest({ command: 'echo "hello" && rm file.txt' }));
		});

		it('should set correct shell language based on OS', async () => {
			setupConfiguration(['echo']);
			vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Windows);

			const result = await executeToolTest({});
			assertAutoApproved(result);
			expect(result.language).toBe('pwsh');
		});

		it('should set correct shell language for non-Windows OS', async () => {
			setupConfiguration(['echo']);
			vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Linux);

			const result = await executeToolTest({});
			assertAutoApproved(result);
			expect(result.language).toBe('sh');
		});

		it('should skip confirmation in simulation tests', async () => {
			setupConfiguration();
			vi.spyOn(simulationTestContext, 'isInSimulationTests', 'get').mockReturnValue(true);

			assertAutoApproved(await executeToolTest({ command: 'rm dangerous-file.txt' }));
		});
	});

	describe('PowerShell-specific auto approval', () => {
		beforeEach(() => {
			// Mock Windows PowerShell environment
			vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Windows);
			vi.spyOn(envService, 'shell', 'get').mockReturnValue('powershell.exe');
		});

		it('should auto-approve PowerShell cmdlets in allow list', async () => {
			setupConfiguration(['Get-ChildItem', 'Write-Host']);

			const result = await executeToolTest({
				command: 'Get-ChildItem -Path .',
				explanation: 'List directory contents'
			});
			assertAutoApproved(result);
			expect(result.language).toBe('pwsh');
		});

		it('should require confirmation for dangerous PowerShell commands', async () => {
			setupConfiguration(['Get-ChildItem'], ['Remove-Item']);

			assertConfirmationRequired(await executeToolTest({
				command: 'Remove-Item -Path file.txt -Force',
				explanation: 'Force remove a file'
			}), 'Run command in terminal');
		});
	});

	describe('edge cases and error conditions', () => {
		it('should handle empty command strings', async () => {
			setupConfiguration(['echo']);

			assertConfirmationRequired(await executeToolTest({
				command: '',
				explanation: 'Empty command'
			}));
		});

		it('should handle commands with only whitespace', async () => {
			setupConfiguration(['echo']);

			assertConfirmationRequired(await executeToolTest({
				command: '   \t\n   ',
				explanation: 'Whitespace only command'
			}));
		});
	});

	describe('additional auto approval scenarios', () => {
		it('should handle case-sensitive command matching', async () => {
			setupConfiguration(['echo']);

			assertConfirmationRequired(await executeToolTest({ command: 'ECHO hello' }));
		});

		it('should handle commands with leading/trailing whitespace', async () => {
			setupConfiguration(['echo']);

			assertConfirmationRequired(await executeToolTest({ command: '  echo hello  ' }));
		});

		it('should handle multiple operators in command chains', async () => {
			setupConfiguration(['echo', 'ls', 'cat']);

			assertAutoApproved(await executeToolTest({ command: 'echo hello | cat && ls -la || echo error' }));
		});

		it('should handle mixed approved and denied commands', async () => {
			setupConfiguration(['echo', 'rm'], ['rm']);

			assertConfirmationRequired(await executeToolTest({ command: 'echo hello && rm file.txt' }));
		});

		it('should handle complex regex patterns in deny list', async () => {
			setupConfiguration(['git'], ['/git.*--force/']);

			assertConfirmationRequired(await executeToolTest({ command: 'git push --force origin main' }));
		});

		it('should handle default configuration values', async () => {
			// Reset to default configuration
			configurationService.setConfig(ConfigKey.TerminalAllowList, undefined);
			configurationService.setConfig(ConfigKey.TerminalDenyList, undefined);

			assertAutoApproved(await executeToolTest({ command: 'echo hello' }));
		});
	});

	describe('command line parsing and validation', () => {
		it('should handle shell-specific command separators', async () => {
			setupConfiguration(['echo']);
			vi.spyOn(envService, 'shell', 'get').mockReturnValue('bash');

			assertAutoApproved(await executeToolTest({ command: 'echo hello; echo world' }));
		});

		it('should handle PowerShell-specific command separators', async () => {
			setupConfiguration(['Write-Host']);
			vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Windows);
			vi.spyOn(envService, 'shell', 'get').mockReturnValue('powershell.exe');

			assertAutoApproved(await executeToolTest({ command: 'Write-Host "hello"; Write-Host "world"' }));
		});
		it('should handle shell-specific command separators', async () => {
			setupConfiguration(['echo']);
			vi.spyOn(envService, 'shell', 'get').mockReturnValue('bash');

			assertAutoApproved(await executeToolTest({ command: 'echo "hello world' }));
			assertConfirmationRequired(await executeToolTest({ command: 'echo "$(rm -rf ~)' }));
		});
	});

	describe('command re-writing', () => {
		function createRewriteOptions(command: string, chatSessionId?: string): vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParams> {
			return {
				input: {
					command,
					explanation: 'Test command',
					isBackground: false
				},
				chatSessionId
			};
		}

		describe('cd <cwd> && <suffix> -> <suffix>', () => {
			beforeEach(() => {
				vi.spyOn(envService, 'shell', 'get').mockReturnValue('pwsh');
			});

			it('should return original command when no cd prefix pattern matches', async () => {
				const options = createRewriteOptions('echo hello world');
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('echo hello world');
			});

			it('should return original command when cd pattern does not have suffix', async () => {
				const options = createRewriteOptions('cd /some/path');
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('cd /some/path');
			});

			it('should rewrite command with && separator when directory matches cwd', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`cd ${testDir} && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should support Set-Location on pwsh', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`Set-Location "${testDir}" && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should support Set-Location -Path on pwsh', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`Set-Location -Path "${testDir}" && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should rewrite command when the path is wrapped in double quotes', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`cd "${testDir}" && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should rewrite command with ; separator when directory matches cwd', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`cd ${testDir}; npm test`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm test');
			});

			it('should not rewrite command when directory does not match cwd', async () => {
				const testDir = '/test/workspace';
				const differentDir = '/different/path';
				const command = `cd ${differentDir} && npm install`;
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe(command);
			});

			it('should use terminal cwd when session terminal exists', async () => {
				const terminalDir = '/terminal/cwd';
				const command = `cd ${terminalDir} && ls -la`;
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue({
					terminal: {} as any,
					shellIntegrationQuality: 1 as any
				});
				vi.spyOn(runInTerminalTool['terminalService'], 'getCwdForSession').mockResolvedValue({
					fsPath: terminalDir
				} as any);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('ls -la');
			});

			it('should handle case-insensitive path comparison on Windows', async () => {
				const testDir = 'C:\\Test\\Workspace';
				const command = `cd c:\\test\\workspace && dir`;
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Windows);
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('dir');
			});

			it('should be case-sensitive on non-Windows platforms', async () => {
				const testDir = '/Test/Workspace';
				const command = `cd /test/workspace && ls`;
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(envService, 'OS', 'get').mockReturnValue(OperatingSystem.Linux);
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe(command);
			});

			it('should return original command when no workspace folders available', async () => {
				const command = 'cd /some/path && npm install';
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe(command);
			});

			it('should return original command when multiple workspace folders available', async () => {
				const command = 'cd /some/path && npm install';
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: '/workspace1' } as any,
					{ fsPath: '/workspace2' } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe(command);
			});

			it('should handle commands with complex suffixes', async () => {
				const testDir = '/test/workspace';
				const command = `cd ${testDir} && npm install && npm test && echo "done"`;
				const options = createRewriteOptions(command, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install && npm test && echo "done"');
			});

			it('should handle session without chatSessionId', async () => {
				const command = 'cd /some/path && npm install';
				const options = createRewriteOptions(command);
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: '/some/path' } as any
				]);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should ignore any trailing back slash', async () => {
				const testDir = 'c:\\test\\workspace';
				const options = createRewriteOptions(`cd ${testDir}\\ && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});

			it('should ignore any trailing forward slash', async () => {
				const testDir = '/test/workspace';
				const options = createRewriteOptions(`cd ${testDir}/ && npm install`, 'session-1');
				vi.spyOn(workspaceService, 'getWorkspaceFolders').mockReturnValue([
					{ fsPath: testDir } as any
				]);
				vi.spyOn(runInTerminalTool['terminalService'], 'getToolTerminalForSession').mockResolvedValue(undefined);
				const result = await runInTerminalTool.rewriteCommandIfNeeded(options);

				expect(result).toBe('npm install');
			});
		});
	});
});
