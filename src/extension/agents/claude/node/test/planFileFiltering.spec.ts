/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../util/vs/base/common/uri';

describe('Plan File Filtering', () => {
	// Helper function to simulate plan file filtering logic
	// This mirrors the logic in claudeCodeAgent.ts _onWillEditTool
	function filterPlanFiles(uris: URI[], userHome: URI): URI[] {
		const planDirUri = URI.joinPath(userHome, '.claude', 'plans');
		return uris.filter(uri => {
			return !uri.toString().startsWith(planDirUri.toString());
		});
	}

	it('should filter out plan files from the .claude/plans directory', () => {
		const userHome = URI.file('/home/user');
		const planFile = URI.joinPath(userHome, '.claude', 'plans', 'test-plan.md');
		const regularFile = URI.file('/workspace/src/test.ts');

		const uris = [planFile, regularFile];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(1);
		expect(filtered[0].toString()).toBe(regularFile.toString());
	});

	it('should not filter files from other .claude subdirectories', () => {
		const userHome = URI.file('/home/user');
		const agentFile = URI.joinPath(userHome, '.claude', 'agents', 'my-agent.md');
		const memoryFile = URI.joinPath(userHome, '.claude', 'CLAUDE.md');

		const uris = [agentFile, memoryFile];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(2);
		expect(filtered).toContain(agentFile);
		expect(filtered).toContain(memoryFile);
	});

	it('should handle multiple plan files and regular files', () => {
		const userHome = URI.file('/home/user');
		const planFile1 = URI.joinPath(userHome, '.claude', 'plans', 'plan1.md');
		const planFile2 = URI.joinPath(userHome, '.claude', 'plans', 'plan2.md');
		const regularFile1 = URI.file('/workspace/src/file1.ts');
		const regularFile2 = URI.file('/workspace/src/file2.ts');

		const uris = [planFile1, regularFile1, planFile2, regularFile2];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(2);
		expect(filtered).toContain(regularFile1);
		expect(filtered).toContain(regularFile2);
	});

	it('should handle empty array', () => {
		const userHome = URI.file('/home/user');
		const filtered = filterPlanFiles([], userHome);

		expect(filtered.length).toBe(0);
	});

	it('should handle array with only plan files', () => {
		const userHome = URI.file('/home/user');
		const planFile1 = URI.joinPath(userHome, '.claude', 'plans', 'plan1.md');
		const planFile2 = URI.joinPath(userHome, '.claude', 'plans', 'plan2.md');

		const uris = [planFile1, planFile2];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(0);
	});

	it('should handle array with only regular files', () => {
		const userHome = URI.file('/home/user');
		const regularFile1 = URI.file('/workspace/src/file1.ts');
		const regularFile2 = URI.file('/workspace/src/file2.ts');

		const uris = [regularFile1, regularFile2];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(2);
		expect(filtered).toContain(regularFile1);
		expect(filtered).toContain(regularFile2);
	});

	it('should work with Windows-style paths', () => {
		const userHome = URI.file('C:/Users/user');
		const planFile = URI.joinPath(userHome, '.claude', 'plans', 'test-plan.md');
		const regularFile = URI.file('C:/workspace/src/test.ts');

		const uris = [planFile, regularFile];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(1);
		expect(filtered[0].toString()).toBe(regularFile.toString());
	});

	it('should work with nested plan files', () => {
		const userHome = URI.file('/home/user');
		const nestedPlanFile = URI.joinPath(userHome, '.claude', 'plans', 'subfolder', 'nested-plan.md');
		const regularFile = URI.file('/workspace/src/test.ts');

		const uris = [nestedPlanFile, regularFile];
		const filtered = filterPlanFiles(uris, userHome);

		expect(filtered.length).toBe(1);
		expect(filtered[0].toString()).toBe(regularFile.toString());
	});
});
