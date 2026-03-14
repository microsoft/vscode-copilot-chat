/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { MockMcpServer } from './testHelpers';

const { mockExecuteCommand, mockWriteFile } = vi.hoisted(() => ({
	mockExecuteCommand: vi.fn(),
	mockWriteFile: vi.fn(),
}));

vi.mock('vscode', () => {
	class MockPosition {
		constructor(public line: number, public character: number) { }
	}
	class MockUri {
		public fsPath: string;
		public scheme: string;
		constructor(public _str: string) {
			this.fsPath = _str.replace('file://', '');
			this.scheme = _str.startsWith('file:') ? 'file' : 'unknown';
		}
		toString() {
			return this._str;
		}
	}
	return {
		Position: MockPosition,
		Uri: {
			parse: (str: string) => new MockUri(str),
			file: (path: string) => new MockUri(`file://${path}`),
		},
		commands: {
			executeCommand: mockExecuteCommand,
		},
	};
});

vi.mock('fs/promises', () => ({
	writeFile: mockWriteFile,
}));

vi.mock('os', () => ({
	tmpdir: () => '/mock/tmpdir',
}));

import { registerRunLspQueryTool } from '../tools/runLspQuery';

describe('runLspQuery tool', () => {
	const logger = new TestLogService();
	let server: MockMcpServer;

	beforeEach(() => {
		vi.clearAllMocks();
		server = new MockMcpServer();
		registerRunLspQueryTool(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, logger);
	});

	it('should register the run_lsp_query tool', () => {
		expect(server.hasToolRegistered('run_lsp_query')).toBe(true);
	});

	it('should execute a generic LSP query correctly without position', async () => {
		mockExecuteCommand.mockResolvedValue([{ name: 'symbol1' }]);
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			command: 'vscode.executeDocumentSymbolProvider',
			uri: 'file:///test/file.ts',
		});

		expect(mockExecuteCommand).toHaveBeenCalledWith('vscode.executeDocumentSymbolProvider', expect.objectContaining({ _str: 'file:///test/file.ts' }));
		expect(result.content[0].text).toContain('symbol1');
		expect(result.content[0].text).toContain('These are the results of executing vscode.executeDocumentSymbolProvider on file:///test/file.ts');
	});

	it('should execute a positional LSP query correctly', async () => {
		mockExecuteCommand.mockResolvedValue({ start: { line: 0, character: 0 }, end: { line: 0, character: 10 } });
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			command: 'vscode.executeHoverProvider',
			uri: 'file:///test/file.ts',
			position: { line: 5, character: 10 }
		});

		// Check the position argument
		const posArg = mockExecuteCommand.mock.calls[0][2];
		expect(posArg.line).toBe(5);
		expect(posArg.character).toBe(10);
		expect(result.content[0].text).toContain('These are the results of executing vscode.executeHoverProvider on file:///test/file.ts at line 5, character 10');
	});

	it('should execute a workspace symbol query with query argument', async () => {
		mockExecuteCommand.mockResolvedValue([]);
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			command: 'vscode.executeWorkspaceSymbolProvider',
			uri: 'file:///test/file.ts',
			query: 'test_query'
		});

		expect(mockExecuteCommand).toHaveBeenCalledWith('vscode.executeWorkspaceSymbolProvider', 'test_query');
		expect(result.content[0].text).toContain('with query "test_query"');
	});

	it('should compact results by grouping them if array is returned with uri elements', async () => {
		const mockResult = [
			{ name: 'test1', uri: { fsPath: '/test/a.ts', toString: () => 'file:///test/a.ts' } },
			{ name: 'test2', location: { uri: { fsPath: '/test/a.ts', toString: () => 'file:///test/a.ts' } } },
			{ name: 'test3', targetUri: { fsPath: '/test/b.ts', toString: () => 'file:///test/b.ts' } }
		];
		mockExecuteCommand.mockResolvedValue(mockResult);

		const handler = server.getToolHandler('run_lsp_query')!;
		const result: any = await handler({
			command: 'vscode.executeDefinitionProvider',
			uri: 'file:///test/file.ts'
		});

		const text = result.content[0].text;
		expect(text).toContain('"/test/a.ts"');
		expect(text).toContain('"/test/b.ts"');
		expect(text).not.toContain('"uri"'); // Assert stripped URI objects inside compact struct
	});

	it('should write to temporary file if result is very long', async () => {
		// Create a very large array > 50 chars to test limit arrays as well, but each object itself very long
		const mockResult = Array.from({ length: 60 }, () => ({ massive_field: 'a'.repeat(2000) }));
		mockExecuteCommand.mockResolvedValue(mockResult);

		const handler = server.getToolHandler('run_lsp_query')!;
		const result: any = await handler({
			command: 'vscode.executeDefinitionProvider',
			uri: 'file:///test/file.ts'
		});

		expect(mockWriteFile).toHaveBeenCalled();
		expect(result.content[0].text).toContain('The result is very long and has been saved to:');
	});

	it('should gracefully handle circular references', async () => {
		const circularObj: any = { prop: 'value' };
		circularObj.self = circularObj;

		mockExecuteCommand.mockResolvedValue([circularObj]);

		const handler = server.getToolHandler('run_lsp_query')!;
		const result: any = await handler({
			command: 'vscode.executeDefinitionProvider',
			uri: 'file:///test/file.ts'
		});

		expect(result.content[0].text).toContain('"[Circular]"');
	});

	it('should catch errors and return them cleanly', async () => {
		mockExecuteCommand.mockRejectedValue(new Error('LSP Error!'));
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			command: 'vscode.executeDefinitionProvider',
			uri: 'file:///test/file.ts'
		});

		expect(result.content[0].text).toContain('Error executing vscode.executeDefinitionProvider: LSP Error!');
	});
});
