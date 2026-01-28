/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ILogService } from '../../../../../../platform/log/common/logService';
import { ITerminalService } from '../../../../../../platform/terminal/common/terminalService';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../util/common/test/testUtils';
import { createExtensionUnitTestingServices } from '../../../../../test/node/services';
import { ClaudeLanguageModelServer } from '../../../node/claudeLanguageModelServer';
import { TerminalSlashCommand } from '../terminalCommand';

describe('TerminalSlashCommand', () => {
	let terminalCommand: TerminalSlashCommand;
	let mockTerminalService: ITerminalService;
	let mockTerminal: vscode.Terminal;
	let instantiationService: IInstantiationService;
	let mockLogService: ILogService;
	let mockLanguageModelServer: ClaudeLanguageModelServer;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		// Create mock terminal
		mockTerminal = {
			show: vi.fn(),
			sendText: vi.fn(),
			dispose: vi.fn(),
		} as any;

		// Create mock terminal service
		mockTerminalService = {
			createTerminal: vi.fn().mockReturnValue(mockTerminal),
		} as any;

		// Create mock language model server
		mockLanguageModelServer = {
			start: vi.fn().mockResolvedValue(undefined),
			getConfig: vi.fn().mockReturnValue({
				port: 12345,
				nonce: 'test-nonce-123',
			}),
		} as any;

		// Create testing services
		const serviceCollection = store.add(createExtensionUnitTestingServices(store));
		serviceCollection.set(ITerminalService, mockTerminalService);

		const accessor = serviceCollection.createTestingAccessor();
		const realInstantiationService = accessor.get(IInstantiationService);
		mockLogService = accessor.get(ILogService);

		// Create a wrapper instantiation service that returns our mock server
		instantiationService = {
			...realInstantiationService,
			createInstance: vi.fn().mockImplementation((ctor: any, ...args: any[]) => {
				if (ctor === ClaudeLanguageModelServer) {
					return mockLanguageModelServer;
				}
				return realInstantiationService.createInstance(ctor, ...args);
			}),
		} as any;

		terminalCommand = realInstantiationService.createInstance(TerminalSlashCommand);
		// Replace the instantiation service in the command with our mock
		(terminalCommand as any).instantiationService = instantiationService;
	});

	describe('command properties', () => {
		it('has correct command name', () => {
			expect(terminalCommand.commandName).toBe('terminal');
		});

		it('has correct description', () => {
			expect(terminalCommand.description).toBe('Create terminal with Claude CLI using Copilot Chat endpoints');
		});

		it('has correct command ID', () => {
			expect(terminalCommand.commandId).toBe('copilot.claude.terminal');
		});
	});

	describe('handle', () => {
		it('creates a terminal with correct environment variables', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockTerminalService.createTerminal).toHaveBeenCalledWith({
				name: 'Claude CLI',
				env: {
					ANTHROPIC_BASE_URL: 'http://localhost:12345',
					ANTHROPIC_API_KEY: 'test-nonce-123',
				}
			});
		});

		it('shows the terminal after creation', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockTerminal.show).toHaveBeenCalled();
		});

		it('sends claude command to terminal', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockTerminal.sendText).toHaveBeenCalledWith('claude');
		});

		it('sends markdown messages to stream', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockStream.markdown).toHaveBeenCalledWith('Creating Claude CLI terminal...');
			expect(mockStream.markdown).toHaveBeenCalledWith('Terminal created and Claude Code started with Copilot Chat endpoints.');
		});

		it('handles undefined stream gracefully', async () => {
			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await expect(terminalCommand.handle('', undefined, mockToken)).resolves.toBeDefined();

			expect(mockTerminalService.createTerminal).toHaveBeenCalled();
			expect(mockTerminal.show).toHaveBeenCalled();
		});

		it('handles errors gracefully', async () => {
			// Make createTerminal throw an error
			vi.spyOn(mockTerminalService, 'createTerminal').mockImplementation(() => {
				throw new Error('Failed to create terminal');
			});

			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('Error creating terminal'));
		});

		it('logs terminal creation info', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			const infoSpy = vi.spyOn(mockLogService, 'info');

			await terminalCommand.handle('', mockStream, mockToken);

			expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Created terminal with Claude CLI configured on port 12345'));
		});

		it('logs errors when terminal creation fails', async () => {
			// Make createTerminal throw an error
			vi.spyOn(mockTerminalService, 'createTerminal').mockImplementation(() => {
				throw new Error('Failed to create terminal');
			});

			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			const errorSpy = vi.spyOn(mockLogService, 'error');

			await terminalCommand.handle('', mockStream, mockToken);

			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe('language model server lifecycle', () => {
		it('starts the language model server on first use', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			await terminalCommand.handle('', mockStream, mockToken);

			expect(mockLanguageModelServer.start).toHaveBeenCalled();
		});

		it('reuses the same server instance for multiple calls', async () => {
			const mockStream = {
				markdown: vi.fn(),
			} as any;

			const mockToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => { } }),
			} as any;

			// Call handle twice
			await terminalCommand.handle('', mockStream, mockToken);
			await terminalCommand.handle('', mockStream, mockToken);

			// Server should only be started once
			expect(mockLanguageModelServer.start).toHaveBeenCalledTimes(1);
			// But terminal should be created twice
			expect(mockTerminalService.createTerminal).toHaveBeenCalledTimes(2);
		});
	});
});
