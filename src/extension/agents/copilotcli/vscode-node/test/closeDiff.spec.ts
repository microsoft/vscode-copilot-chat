/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';

vi.mock('vscode', () => ({
	Uri: {
		file: (path: string) => ({ fsPath: path, scheme: 'file' }),
	},
	window: {
		tabGroups: {
			activeTabGroup: {
				activeTab: null,
			},
			all: [],
			onDidChangeTabGroups: () => ({ dispose: () => { } }),
			onDidChangeTabs: () => ({ dispose: () => { } }),
		},
	},
	commands: {
		executeCommand: vi.fn(),
	},
	TabInputTextDiff: class TabInputTextDiff {
		constructor(public original: any, public modified: any) { }
	},
}));

import {
	registerActiveDiff,
	unregisterActiveDiff,
	getActiveDiffByTabName,
	type ActiveDiff,
} from '../diffState';
import { registerCloseDiffTool } from '../tools/closeDiff';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function createMockServer() {
	const tools: Map<string, { handler: ToolHandler; schema: unknown }> = new Map();
	return {
		tool: (name: string, description: string, schema: unknown, handler: ToolHandler) => {
			tools.set(name, { handler, schema });
		},
		getToolHandler: (name: string) => tools.get(name)?.handler,
		getToolSchema: (name: string) => tools.get(name)?.schema,
	};
}

function parseResult(result: any): any {
	const text = result.content[0].text;
	return JSON.parse(text);
}

describe('closeDiff tool', () => {
	const logger = new TestLogService();

	const createMockDiff = (tabName: string, diffIdSuffix?: string): ActiveDiff => ({
		diffId: `/tmp/modified-${diffIdSuffix ?? tabName}.ts`,
		tabName: tabName,
		originalUri: { fsPath: `/path/to/original-${tabName}.ts`, scheme: 'file' } as any,
		modifiedUri: { fsPath: `/tmp/modified-${diffIdSuffix ?? tabName}.ts`, scheme: 'file' } as any,
		newContents: `// new contents for ${tabName}`,
		cleanup: vi.fn(),
		resolve: vi.fn(),
	});

	beforeEach(() => {
		const testDiffIds = [
			'/tmp/modified-My Test Diff.ts', '/tmp/modified-Idempotent Test.ts',
			'/tmp/modified-First Diff.ts', '/tmp/modified-Second Diff.ts', '/tmp/modified-Third Diff.ts',
			'/tmp/modified-Special: → ñ 中文 🔧.ts', '/tmp/modified-Tab A.ts', '/tmp/modified-Tab B.ts', '/tmp/modified-Tab C.ts',
			'/tmp/modified-diff1.ts', '/tmp/modified-diff2.ts',
			'/tmp/modified-Diff: src/file.ts → modified (2024-01-23).ts',
			'/tmp/other-modified.ts',
		];
		testDiffIds.push(`/tmp/modified-${'A'.repeat(1000)}.ts`);
		testDiffIds.push('/tmp/modified-编辑文件 🔧 файл.ts.ts');
		testDiffIds.forEach(id => unregisterActiveDiff(id));
	});

	it('should register the close_diff tool', () => {
		const mockServer = createMockServer();
		registerCloseDiffTool(mockServer as any, logger);

		expect(mockServer.getToolHandler('close_diff')).toBeDefined();
	});

	it('should close an active diff by tab name', async () => {
		const mockServer = createMockServer();
		registerCloseDiffTool(mockServer as any, logger);

		const diff = createMockDiff('My Test Diff');
		registerActiveDiff(diff);

		const handler = mockServer.getToolHandler('close_diff')!;
		const result = await handler({ tab_name: 'My Test Diff' });
		const parsed = parseResult(result);

		expect(parsed.success).toBe(true);
		expect(parsed.already_closed).toBe(false);
		expect(parsed.tab_name).toBe('My Test Diff');
		expect(parsed.message).toContain('closed successfully');

		expect(diff.resolve).toHaveBeenCalledWith({
			status: 'REJECTED',
			trigger: 'closed_via_tool',
		});
	});

	it('should return success with already_closed=true for non-existent tab', async () => {
		const mockServer = createMockServer();
		registerCloseDiffTool(mockServer as any, logger);

		const handler = mockServer.getToolHandler('close_diff')!;
		const result = await handler({ tab_name: 'Non-existent Tab' });
		const parsed = parseResult(result);

		expect(parsed.success).toBe(true);
		expect(parsed.already_closed).toBe(true);
		expect(parsed.tab_name).toBe('Non-existent Tab');
		expect(parsed.message).toContain('may already be closed');
	});

	it('should be idempotent - closing same tab twice returns success', async () => {
		const mockServer = createMockServer();
		registerCloseDiffTool(mockServer as any, logger);

		const diff = createMockDiff('Idempotent Test');
		registerActiveDiff(diff);

		const handler = mockServer.getToolHandler('close_diff')!;

		const result1 = await handler({ tab_name: 'Idempotent Test' });
		const parsed1 = parseResult(result1);
		expect(parsed1.success).toBe(true);
		expect(parsed1.already_closed).toBe(false);

		unregisterActiveDiff(diff.diffId);

		const result2 = await handler({ tab_name: 'Idempotent Test' });
		const parsed2 = parseResult(result2);
		expect(parsed2.success).toBe(true);
		expect(parsed2.already_closed).toBe(true);
	});

	it('should close the correct diff when multiple diffs are open', async () => {
		const mockServer = createMockServer();
		registerCloseDiffTool(mockServer as any, logger);

		const diff1 = createMockDiff('First Diff');
		const diff2 = createMockDiff('Second Diff');
		const diff3 = createMockDiff('Third Diff');
		registerActiveDiff(diff1);
		registerActiveDiff(diff2);
		registerActiveDiff(diff3);

		const handler = mockServer.getToolHandler('close_diff')!;

		const result = await handler({ tab_name: 'Second Diff' });
		const parsed = parseResult(result);

		expect(parsed.success).toBe(true);
		expect(parsed.already_closed).toBe(false);

		expect(diff1.resolve).not.toHaveBeenCalled();
		expect(diff2.resolve).toHaveBeenCalledWith({
			status: 'REJECTED',
			trigger: 'closed_via_tool',
		});
		expect(diff3.resolve).not.toHaveBeenCalled();

		expect(getActiveDiffByTabName('First Diff')).toBe(diff1);
		expect(getActiveDiffByTabName('Third Diff')).toBe(diff3);
	});

	describe('edge cases', () => {
		it('should handle empty tab name', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: '' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(true);
		});

		it('should handle tab name with special characters', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const diff = createMockDiff('Diff: src/file.ts → modified (2024-01-23)');
			registerActiveDiff(diff);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: 'Diff: src/file.ts → modified (2024-01-23)' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(false);
			expect(diff.resolve).toHaveBeenCalled();
		});

		it('should handle closing tab that was never opened', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: 'Never Existed Tab' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(true);
			expect(parsed.message).toContain('may already be closed');
		});

		it('should handle multiple diffs with same tab name but different diffIds', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const diff1 = createMockDiff('Duplicate Name', 'diff1');
			const diff2 = createMockDiff('Duplicate Name', 'diff2');
			registerActiveDiff(diff1);
			registerActiveDiff(diff2);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: 'Duplicate Name' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(false);

			expect(diff1.resolve).toHaveBeenCalled();
			expect(diff2.resolve).not.toHaveBeenCalled();

			unregisterActiveDiff(diff1.diffId);

			expect(getActiveDiffByTabName('Duplicate Name')).toBe(diff2);
		});

		it('should handle rapid successive closes of different tabs', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const diff1 = createMockDiff('Tab A');
			const diff2 = createMockDiff('Tab B');
			const diff3 = createMockDiff('Tab C');
			registerActiveDiff(diff1);
			registerActiveDiff(diff2);
			registerActiveDiff(diff3);

			const handler = mockServer.getToolHandler('close_diff')!;

			const [result1, result2, result3] = await Promise.all([
				handler({ tab_name: 'Tab A' }),
				handler({ tab_name: 'Tab B' }),
				handler({ tab_name: 'Tab C' }),
			]);

			expect(parseResult(result1).success).toBe(true);
			expect(parseResult(result2).success).toBe(true);
			expect(parseResult(result3).success).toBe(true);

			expect(diff1.resolve).toHaveBeenCalled();
			expect(diff2.resolve).toHaveBeenCalled();
			expect(diff3.resolve).toHaveBeenCalled();
		});

		it('should handle tab name that is very long', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const longTabName = 'A'.repeat(1000);
			const diff = createMockDiff(longTabName);
			registerActiveDiff(diff);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: longTabName });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(false);
			expect(diff.resolve).toHaveBeenCalled();
		});

		it('should handle whitespace-only tab name', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: '   ' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(true);
		});

		it('should handle tab name with unicode characters', async () => {
			const mockServer = createMockServer();
			registerCloseDiffTool(mockServer as any, logger);

			const diff = createMockDiff('编辑文件 🔧 файл.ts');
			registerActiveDiff(diff);

			const handler = mockServer.getToolHandler('close_diff')!;
			const result = await handler({ tab_name: '编辑文件 🔧 файл.ts' });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.already_closed).toBe(false);
			expect(diff.resolve).toHaveBeenCalled();
		});
	});
});
