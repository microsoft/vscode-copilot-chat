/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { gitDiffFilter, lsFilter, npmInstallFilter, parseCommandHead } from '../compressors/terminalOutputCompressor';

describe('parseCommandHead', () => {
	it('returns undefined for empty input', () => {
		expect(parseCommandHead(undefined)).toBeUndefined();
		expect(parseCommandHead('')).toBeUndefined();
		expect(parseCommandHead('   ')).toBeUndefined();
	});
	it('parses simple commands', () => {
		expect(parseCommandHead('git diff HEAD~5')).toEqual({ head: 'git', sub: 'diff' });
		expect(parseCommandHead('ls -la')).toEqual({ head: 'ls', sub: '-la' });
	});
	it('skips env-var prefixes', () => {
		expect(parseCommandHead('CI=1 NODE_ENV=test npm install')).toEqual({ head: 'npm', sub: 'install' });
	});
	it('uses only first pipeline segment', () => {
		expect(parseCommandHead('git diff | cat')).toEqual({ head: 'git', sub: 'diff' });
	});
	it('skips leading long flags before the subcommand', () => {
		expect(parseCommandHead('git --no-pager diff src/foo.ts')).toEqual({ head: 'git', sub: 'diff' });
	});
	it('skips short flag plus value before the subcommand', () => {
		expect(parseCommandHead('git -C /tmp/repo diff')).toEqual({ head: 'git', sub: '-C' });
	});
});

describe('gitDiffFilter', () => {
	const input = { command: 'git diff HEAD~1' };

	it('matches git diff', () => {
		expect(gitDiffFilter.matches('run_in_terminal', input)).toBe(true);
	});
	it('matches git --no-pager diff', () => {
		expect(gitDiffFilter.matches('run_in_terminal', { command: 'git --no-pager diff src/foo.ts' })).toBe(true);
	});
	it('does not match git status', () => {
		expect(gitDiffFilter.matches('run_in_terminal', { command: 'git status' })).toBe(false);
	});
	it('preserves +/- and hunk headers verbatim', () => {
		const text = [
			'diff --git a/foo.ts b/foo.ts',
			'index abc..def 100644',
			'--- a/foo.ts',
			'+++ b/foo.ts',
			'@@ -1,3 +1,3 @@',
			' unchanged',
			'-old',
			'+new',
			' unchanged',
		].join('\n');
		const out = gitDiffFilter.apply(text, input);
		expect(out.text).toContain('-old');
		expect(out.text).toContain('+new');
		expect(out.text).toContain('@@ -1,3 +1,3 @@');
		expect(out.text).not.toContain('index abc..def');
	});
	it('collapses long unchanged-context runs into a single marker', () => {
		const ctxLines = Array.from({ length: 20 }, (_, i) => ` this is context line number ${i}`);
		const text = [
			'diff --git a/foo.ts b/foo.ts',
			'--- a/foo.ts',
			'+++ b/foo.ts',
			'@@ -1,22 +1,22 @@',
			...ctxLines,
			'-old',
			'+new',
		].join('\n');
		const out = gitDiffFilter.apply(text, input);
		// First context line is kept verbatim, the next 19 are collapsed.
		expect(out.text).toContain(' this is context line number 0');
		expect(out.text).not.toContain(' this is context line number 5');
		expect(out.text).not.toContain(' this is context line number 19');
		expect(out.text).toContain('19 unchanged context lines omitted');
		expect(out.text).toContain('-old');
		expect(out.text).toContain('+new');
		expect(out.compressed).toBe(true);
	});
	it('omits lockfile diffs', () => {
		const text = [
			'diff --git a/package-lock.json b/package-lock.json',
			'index 1..2 100644',
			'--- a/package-lock.json',
			'+++ b/package-lock.json',
			'@@ -1,3 +1,3 @@',
			'-old',
			'+new',
		].join('\n');
		const out = gitDiffFilter.apply(text, input);
		expect(out.text).toContain('lockfile/snapshot diff omitted');
		expect(out.text).not.toContain('-old');
		expect(out.compressed).toBe(true);
	});
	it('rewrites hunk header counts to match emitted body', () => {
		// 20 context lines + 1 minus + 1 plus. Filter keeps 1 context + the
		// change lines, so the body has 2 old-side and 2 new-side lines, and
		// the rewritten header should reflect that.
		const ctxLines = Array.from({ length: 20 }, (_, i) => ` ctx line ${i}`);
		const text = [
			'diff --git a/foo.ts b/foo.ts',
			'--- a/foo.ts',
			'+++ b/foo.ts',
			'@@ -10,22 +10,22 @@',
			...ctxLines,
			'-old',
			'+new',
		].join('\n');
		const out = gitDiffFilter.apply(text, input);
		expect(out.text).toContain('@@ -10,2 +10,2 @@');
		expect(out.text).not.toContain('@@ -10,22 +10,22 @@');
	});
});

describe('lsFilter', () => {
	it('matches only when -l flag present', () => {
		expect(lsFilter.matches('run_in_terminal', { command: 'ls' })).toBe(false);
		expect(lsFilter.matches('run_in_terminal', { command: 'ls -la' })).toBe(true);
		expect(lsFilter.matches('run_in_terminal', { command: 'ls -al src/' })).toBe(true);
	});
	it('strips long-form columns and keeps file names', () => {
		const text = [
			'total 24',
			'-rw-r--r--   1 user  staff   123 Jan 01 12:34 README.md',
			'drwxr-xr-x   5 user  staff   160 Jan 01 12:34 src',
		].join('\n');
		const out = lsFilter.apply(text, { command: 'ls -la' });
		expect(out.text).toContain('README.md');
		expect(out.text).toContain('src/');
		expect(out.text).not.toContain('user  staff');
		expect(out.text).not.toContain('total 24');
		expect(out.compressed).toBe(true);
	});
});

describe('npmInstallFilter', () => {
	it('matches npm install', () => {
		expect(npmInstallFilter.matches('run_in_terminal', { command: 'npm install' })).toBe(true);
		expect(npmInstallFilter.matches('run_in_terminal', { command: 'npm ci' })).toBe(true);
		expect(npmInstallFilter.matches('run_in_terminal', { command: 'npm test' })).toBe(false);
	});
	it('drops audit and funding noise', () => {
		const text = [
			'added 250 packages in 12s',
			'npm warn deprecated foo@1.0.0: please update',
			'42 packages are looking for funding',
			'  run `npm fund` for details',
			'',
			'3 vulnerabilities (1 low, 2 moderate)',
			'Run `npm audit` for details.',
		].join('\n');
		const out = npmInstallFilter.apply(text, { command: 'npm install' });
		expect(out.text).toContain('added 250 packages');
		expect(out.text).not.toContain('deprecated foo');
		expect(out.text).not.toContain('looking for funding');
		expect(out.text).not.toContain('npm audit');
		expect(out.compressed).toBe(true);
	});
});
