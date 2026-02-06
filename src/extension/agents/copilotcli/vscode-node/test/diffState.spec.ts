/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	registerActiveDiff,
	unregisterActiveDiff,
	getActiveDiffByTabName,
	hasActiveDiffs,
	type ActiveDiff,
} from '../diffState';

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

describe('diffState', () => {
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
			'/tmp/modified-Test Diff 1.ts', '/tmp/modified-Test Diff 2.ts', '/tmp/modified-Test Diff 3.ts',
			'/tmp/modified-My Diff Tab.ts', '/tmp/modified-Another Tab.ts', '/tmp/modified-Existing Tab.ts',
			'/tmp/modified-diff1.ts', '/tmp/modified-diff2.ts',
			'/tmp/modified-v1.ts', '/tmp/modified-v2.ts',
			'/tmp/modified-Original Tab.ts', '/tmp/modified-new.ts',
		];
		for (let i = 0; i < 10; i++) {
			testDiffIds.push(`/tmp/modified-Concurrent Tab ${i}.ts`);
		}
		testDiffIds.forEach(id => unregisterActiveDiff(id));
	});

	describe('registerActiveDiff and getActiveDiffByTabName', () => {
		it('should register and retrieve a diff by tabName', () => {
			const diff = createMockDiff('Test Diff 1');
			registerActiveDiff(diff);

			const retrieved = getActiveDiffByTabName('Test Diff 1');
			expect(retrieved).toBe(diff);
		});

		it('should return undefined for non-existent tabName', () => {
			const retrieved = getActiveDiffByTabName('non-existent');
			expect(retrieved).toBeUndefined();
		});
	});

	describe('unregisterActiveDiff', () => {
		it('should remove a registered diff', () => {
			const diff = createMockDiff('Test Diff 2');
			registerActiveDiff(diff);
			expect(getActiveDiffByTabName('Test Diff 2')).toBe(diff);

			unregisterActiveDiff(diff.diffId);
			expect(getActiveDiffByTabName('Test Diff 2')).toBeUndefined();
		});

		it('should not throw when unregistering non-existent diff', () => {
			expect(() => unregisterActiveDiff('/tmp/non-existent.ts')).not.toThrow();
		});
	});

	describe('getActiveDiffByTabName', () => {
		it('should find diff by tab name', () => {
			const diff1 = createMockDiff('My Diff Tab');
			const diff2 = createMockDiff('Another Tab');
			registerActiveDiff(diff1);
			registerActiveDiff(diff2);

			const found = getActiveDiffByTabName('My Diff Tab');
			expect(found).toBe(diff1);

			const found2 = getActiveDiffByTabName('Another Tab');
			expect(found2).toBe(diff2);
		});

		it('should return undefined for non-existent tab name', () => {
			const diff = createMockDiff('Existing Tab');
			registerActiveDiff(diff);

			const found = getActiveDiffByTabName('Non-existent Tab');
			expect(found).toBeUndefined();
		});

		it('should allow multiple diffs with same tab name but different diffIds', () => {
			const diff1 = createMockDiff('Duplicate Name', 'diff1');
			const diff2 = createMockDiff('Duplicate Name', 'diff2');
			registerActiveDiff(diff1);
			registerActiveDiff(diff2);

			const found = getActiveDiffByTabName('Duplicate Name');
			expect(found).toBe(diff1);

			unregisterActiveDiff(diff1.diffId);
			const foundAfter = getActiveDiffByTabName('Duplicate Name');
			expect(foundAfter).toBe(diff2);
		});
	});

	describe('hasActiveDiffs', () => {
		it('should return false when no diffs are registered', () => {
			expect(hasActiveDiffs()).toBe(false);
		});

		it('should return true when diffs are registered', () => {
			const diff = createMockDiff('Test Diff 3');
			registerActiveDiff(diff);
			expect(hasActiveDiffs()).toBe(true);
		});

		it('should return false after all diffs are unregistered', () => {
			const diff = createMockDiff('Test Diff 3');
			registerActiveDiff(diff);
			expect(hasActiveDiffs()).toBe(true);

			unregisterActiveDiff(diff.diffId);
			expect(hasActiveDiffs()).toBe(false);
		});
	});

	describe('edge cases', () => {
		it('should handle multiple diffs for the same original file', () => {
			const diff1: ActiveDiff = {
				diffId: '/tmp/modified-v1.ts',
				tabName: 'file.ts (version 1)',
				originalUri: { fsPath: '/path/to/file.ts', scheme: 'file' } as any,
				modifiedUri: { fsPath: '/tmp/modified-v1.ts', scheme: 'file' } as any,
				newContents: '// version 1',
				cleanup: vi.fn(),
				resolve: vi.fn(),
			};
			const diff2: ActiveDiff = {
				diffId: '/tmp/modified-v2.ts',
				tabName: 'file.ts (version 2)',
				originalUri: { fsPath: '/path/to/file.ts', scheme: 'file' } as any,
				modifiedUri: { fsPath: '/tmp/modified-v2.ts', scheme: 'file' } as any,
				newContents: '// version 2',
				cleanup: vi.fn(),
				resolve: vi.fn(),
			};

			registerActiveDiff(diff1);
			registerActiveDiff(diff2);

			expect(getActiveDiffByTabName('file.ts (version 1)')).toBe(diff1);
			expect(getActiveDiffByTabName('file.ts (version 2)')).toBe(diff2);

			unregisterActiveDiff(diff1.diffId);
			unregisterActiveDiff(diff2.diffId);
		});

		it('should handle re-registering same diffId (overwrites)', () => {
			const diff1 = createMockDiff('Original Tab');
			const diff2: ActiveDiff = {
				diffId: diff1.diffId,
				tabName: 'New Tab',
				originalUri: { fsPath: '/path/to/new.ts', scheme: 'file' } as any,
				modifiedUri: { fsPath: '/tmp/new-modified.ts', scheme: 'file' } as any,
				newContents: '// new content',
				cleanup: vi.fn(),
				resolve: vi.fn(),
			};

			registerActiveDiff(diff1);
			expect(getActiveDiffByTabName('Original Tab')).toBe(diff1);

			registerActiveDiff(diff2);
			expect(getActiveDiffByTabName('Original Tab')).toBeUndefined();
			expect(getActiveDiffByTabName('New Tab')).toBe(diff2);
		});

		it('should handle concurrent registrations', () => {
			const diffs = Array.from({ length: 10 }, (_, i) =>
				createMockDiff(`Concurrent Tab ${i}`)
			);

			diffs.forEach(registerActiveDiff);

			diffs.forEach((diff, i) => {
				expect(getActiveDiffByTabName(`Concurrent Tab ${i}`)).toBe(diff);
			});

			diffs.forEach(diff => unregisterActiveDiff(diff.diffId));
		});
	});
});
