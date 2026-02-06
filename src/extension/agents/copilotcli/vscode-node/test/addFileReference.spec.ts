/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import type { InProcHttpServer } from '../inProcHttpServer';
import { MockHttpServer, createMockEditor } from './testHelpers';

const { mockRegisterCommand, mockActiveTextEditor } = vi.hoisted(() => ({
	mockRegisterCommand: vi.fn(),
	mockActiveTextEditor: { value: null as unknown },
}));

vi.mock('vscode', () => ({
	window: {
		get activeTextEditor() { return mockActiveTextEditor.value; },
		showWarningMessage: vi.fn(),
	},
	commands: {
		registerCommand: (...args: unknown[]) => mockRegisterCommand(...args),
	},
}));

import * as vscode from 'vscode';
import { registerAddFileReferenceCommand, ADD_FILE_REFERENCE_COMMAND, ADD_FILE_REFERENCE_NOTIFICATION } from '../commands/addFileReference';

describe('addFileReference command', () => {
	const logger = new TestLogService();
	let httpServer: MockHttpServer;
	let registeredCommands: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		httpServer = new MockHttpServer();
		registeredCommands = new Map();
		mockActiveTextEditor.value = null;

		mockRegisterCommand.mockImplementation((name: string, callback: (...args: unknown[]) => void) => {
			registeredCommands.set(name, callback);
			return { dispose: () => { } };
		});
	});

	it('should register the command', () => {
		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);
		expect(registeredCommands.has(ADD_FILE_REFERENCE_COMMAND)).toBe(true);
	});

	it('should broadcast file reference from URI (explorer context menu)', () => {
		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);

		const uri = {
			fsPath: '/test/explorer-file.ts',
			toString: () => 'file:///test/explorer-file.ts',
		};

		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!(uri);

		expect(httpServer.broadcastNotification).toHaveBeenCalledWith(
			ADD_FILE_REFERENCE_NOTIFICATION,
			expect.objectContaining({
				filePath: '/test/explorer-file.ts',
				fileUrl: 'file:///test/explorer-file.ts',
				selection: null,
				selectedText: null,
			}),
		);
	});

	it('should broadcast file reference from active editor with no selection', () => {
		mockActiveTextEditor.value = createMockEditor('/test/active-file.ts', 'Hello World', 0, 0, 0, 0);

		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);
		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!();

		expect(httpServer.broadcastNotification).toHaveBeenCalledWith(
			ADD_FILE_REFERENCE_NOTIFICATION,
			expect.objectContaining({
				filePath: '/test/active-file.ts',
				selection: null,
				selectedText: null,
			}),
		);
	});

	it('should include selection info when text is selected', () => {
		mockActiveTextEditor.value = createMockEditor('/test/file.ts', 'line 0\nline 1\nline 2', 1, 0, 1, 6);

		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);
		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!();

		expect(httpServer.broadcastNotification).toHaveBeenCalledWith(
			ADD_FILE_REFERENCE_NOTIFICATION,
			expect.objectContaining({
				filePath: '/test/file.ts',
				selection: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 6 },
				},
				selectedText: 'line 1',
			}),
		);
	});

	it('should include multi-line selection info', () => {
		mockActiveTextEditor.value = createMockEditor('/test/file.ts', 'line 0\nline 1\nline 2', 0, 0, 2, 6);

		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);
		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!();

		expect(httpServer.broadcastNotification).toHaveBeenCalledWith(
			ADD_FILE_REFERENCE_NOTIFICATION,
			expect.objectContaining({
				selection: {
					start: { line: 0, character: 0 },
					end: { line: 2, character: 6 },
				},
				selectedText: 'line 0\nline 1\nline 2',
			}),
		);
	});

	it('should show warning when no active editor and no URI', () => {
		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);
		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!();

		expect(httpServer.broadcastNotification).not.toHaveBeenCalled();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			'No active editor. Open a file to add a reference.',
		);
	});

	it('should prefer provided URI over active editor', () => {
		mockActiveTextEditor.value = createMockEditor('/test/active-file.ts', 'Active content', 0, 0, 0, 6);

		registerAddFileReferenceCommand(logger, httpServer as unknown as InProcHttpServer);

		const explorerUri = {
			fsPath: '/test/explorer-file.ts',
			toString: () => 'file:///test/explorer-file.ts',
		};
		registeredCommands.get(ADD_FILE_REFERENCE_COMMAND)!(explorerUri);

		expect(httpServer.broadcastNotification).toHaveBeenCalledWith(
			ADD_FILE_REFERENCE_NOTIFICATION,
			expect.objectContaining({
				filePath: '/test/explorer-file.ts',
				selection: null,
				selectedText: null,
			}),
		);
	});
});
