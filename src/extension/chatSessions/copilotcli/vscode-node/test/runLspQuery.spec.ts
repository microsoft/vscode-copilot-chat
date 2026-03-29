/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { MockMcpServer } from './testHelpers';

const { mockExecuteCommand } = vi.hoisted(() => ({
	mockExecuteCommand: vi.fn(),
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

import { MAX_RESULT_LENGTH, registerRunLspQueryTool } from '../tools/runLspQuery';

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
			operation: 'documentSymbol',
			uri: 'file:///test/file.ts',
		});

		expect(mockExecuteCommand).toHaveBeenCalledWith('vscode.executeDocumentSymbolProvider', expect.objectContaining({ _str: 'file:///test/file.ts' }));
		expect(result.content[0].text).toContain('symbol1');
		expect(result.content[0].text).toContain('These are the results of executing documentSymbol on file:///test/file.ts');
	});

	it('should execute a positional LSP query correctly', async () => {
		mockExecuteCommand.mockResolvedValue([{ contents: ['hover info text'] }]);
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			operation: 'hover',
			uri: 'file:///test/file.ts',
			line: 5,
			character: 10
		});

		// Check the position argument
		const posArg = mockExecuteCommand.mock.calls[0][2];
		expect(posArg.line).toBe(5);
		expect(posArg.character).toBe(10);
		expect(result.content[0].text).toContain('These are the results of executing hover on file:///test/file.ts at line 5, character 10');
		expect(result.content[0].text).toContain('hover info text');
	});

	it('should execute a workspace symbol query with query argument', async () => {
		mockExecuteCommand.mockResolvedValue([]);
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			operation: 'workspaceSymbol',
			query: 'test_query'
		});

		expect(mockExecuteCommand).toHaveBeenCalledWith('vscode.executeWorkspaceSymbolProvider', 'test_query');
		expect(result.content[0].text).toContain('with query "test_query"');
	});

	it('should truncate the result if it is very long', async () => {
		// Create a very large array > 50 chars to test limit arrays as well, but each object itself very long
		const mockResult = Array.from({ length: 60 }, () => ({ contents: ['a'.repeat(2000)] }));
		mockExecuteCommand.mockResolvedValue(mockResult);

		const handler = server.getToolHandler('run_lsp_query')!;
		const result: any = await handler({
			operation: 'hover',
			uri: 'file:///test/file.ts',
			line: 1,
			character: 1
		});

		expect(result.content[0].text).toContain('The result is very long');
		expect(result.content[0].text).toContain(`has been truncated to the first ${MAX_RESULT_LENGTH} characters`);
		expect(result.content[0].text).toContain('... (truncated)');
	});

	it.skip('should gracefully handle circular references in fallback JSON stringify', async () => {
		const circularObj: any = { prop: 'value' };
		circularObj.self = circularObj;

		mockExecuteCommand.mockResolvedValue([circularObj]);

		const handler = server.getToolHandler('run_lsp_query')!;
		const result: any = await handler({
			operation: 'unknown_operation_if_added_in_future' as any,
			uri: 'file:///test/file.ts',
			line: 1,
			character: 1
		});

		expect(result.content[0].text).toContain('"[Circular]"');
	});

	it('should catch errors and return them cleanly', async () => {
		mockExecuteCommand.mockRejectedValue(new Error('LSP Error!'));
		const handler = server.getToolHandler('run_lsp_query')!;

		const result: any = await handler({
			operation: 'goToDefinition',
			uri: 'file:///test/file.ts',
			line: 1,
			character: 1
		});

		expect(result.content[0].text).toContain('Error executing goToDefinition: LSP Error!');
	});
});
