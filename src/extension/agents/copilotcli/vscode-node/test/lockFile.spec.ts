/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';

vi.mock('vscode', async (importOriginal) => {
	const original = await importOriginal<typeof import('vscode')>();
	return {
		...original,
		workspace: {
			workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
		},
		env: {
			appName: 'Visual Studio Code',
		},
	};
});

import { LockFileHandle, createLockFile, isProcessRunning, cleanupStaleLockFiles } from '../lockFile';

const logger = new TestLogService();

describe('LockFileHandle', () => {
	const testDir = path.join(os.tmpdir(), 'lockfile-test-' + Date.now());
	const testLockFilePath = path.join(testDir, 'test.lock');
	const mockServerUri = { path: '/tmp/test.sock', scheme: 'http' } as any;
	const mockHeaders = { Authorization: 'Bearer test-token' };
	const testTimestamp = Date.now();

	beforeEach(() => {
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe('constructor and path getter', () => {
		it('should store the lock file path', () => {
			const handle = new LockFileHandle(testLockFilePath, mockServerUri, mockHeaders, testTimestamp, logger);
			expect(handle.path).toBe(testLockFilePath);
		});
	});

	describe('update', () => {
		it('should write lock file with correct content', () => {
			const handle = new LockFileHandle(testLockFilePath, mockServerUri, mockHeaders, testTimestamp, logger);
			handle.update();

			expect(fs.existsSync(testLockFilePath)).toBe(true);

			const content = JSON.parse(fs.readFileSync(testLockFilePath, 'utf-8'));
			expect(content.socketPath).toBe('/tmp/test.sock');
			expect(content.scheme).toBe('http');
			expect(content.headers).toEqual(mockHeaders);
			expect(content.pid).toBe(process.pid);
			expect(content.timestamp).toBe(testTimestamp);
		});

		it.skipIf(process.platform === 'win32')('should set restrictive file permissions (0o600)', () => {
			const handle = new LockFileHandle(testLockFilePath, mockServerUri, mockHeaders, testTimestamp, logger);
			handle.update();

			const stats = fs.statSync(testLockFilePath);
			const mode = stats.mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	describe('remove', () => {
		it('should delete the lock file if it exists', () => {
			fs.writeFileSync(testLockFilePath, '{}');
			expect(fs.existsSync(testLockFilePath)).toBe(true);

			const handle = new LockFileHandle(testLockFilePath, mockServerUri, mockHeaders, testTimestamp, logger);
			handle.remove();

			expect(fs.existsSync(testLockFilePath)).toBe(false);
		});

		it('should not throw if lock file does not exist', () => {
			const handle = new LockFileHandle(testLockFilePath, mockServerUri, mockHeaders, testTimestamp, logger);
			expect(() => handle.remove()).not.toThrow();
		});
	});
});

describe('createLockFile', () => {
	let createdLockFile: string | null = null;

	afterEach(() => {
		if (createdLockFile && fs.existsSync(createdLockFile)) {
			fs.unlinkSync(createdLockFile);
			createdLockFile = null;
		}
	});

	it('should create lock file in .copilot directory', async () => {
		const mockServerUri = { path: '/tmp/server.sock', scheme: 'http' } as any;
		const mockHeaders = { 'X-Test': 'value' };

		const handle = await createLockFile(mockServerUri, mockHeaders, logger);
		createdLockFile = handle.path;

		expect(handle.path).toMatch(/\.copilot[/\\]ide.*\.lock$/);
		expect(fs.existsSync(handle.path)).toBe(true);

		const content = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
		expect(content.socketPath).toBe('/tmp/server.sock');
		expect(content.scheme).toBe('http');
		expect(content.headers).toEqual(mockHeaders);
		expect(content.pid).toBe(process.pid);
		expect(typeof content.timestamp).toBe('number');
	});

	it('should create .copilot directory if it does not exist', async () => {
		const mockServerUri = { path: '/tmp/server.sock', scheme: 'http' } as any;
		const handle = await createLockFile(mockServerUri, {}, logger);
		createdLockFile = handle.path;

		const copilotDir = path.dirname(handle.path);
		expect(fs.existsSync(copilotDir)).toBe(true);
	});

	it('should generate unique lock file names', async () => {
		const mockServerUri = { path: '/tmp/server.sock', scheme: 'http' } as any;

		const handle1 = await createLockFile(mockServerUri, {}, logger);
		const handle2 = await createLockFile(mockServerUri, {}, logger);

		expect(handle1.path).not.toBe(handle2.path);

		handle1.remove();
		handle2.remove();
	});
});

describe('isProcessRunning', () => {
	it('should return true for current process', () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	it('should return false for non-existent process', () => {
		expect(isProcessRunning(999999999)).toBe(false);
	});
});

describe('cleanupStaleLockFiles', () => {
	const testDir = path.join(os.tmpdir(), 'lockfile-cleanup-test-' + Date.now());
	const copilotDir = path.join(testDir, '.copilot', 'ide');
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = testDir;
		if (!fs.existsSync(copilotDir)) {
			fs.mkdirSync(copilotDir, { recursive: true });
		}
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.XDG_STATE_HOME = originalEnv;
		} else {
			delete process.env.XDG_STATE_HOME;
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	it('should remove lockfiles for non-running processes', () => {
		const staleLockFile = path.join(copilotDir, 'stale.lock');
		const staleLockInfo = {
			socketPath: '/tmp/test.sock',
			scheme: 'http',
			headers: {},
			pid: 999999999,
			ideName: 'Test',
			timestamp: Date.now(),
			workspaceFolders: [],
		};
		fs.writeFileSync(staleLockFile, JSON.stringify(staleLockInfo));

		expect(fs.existsSync(staleLockFile)).toBe(true);
		const cleaned = cleanupStaleLockFiles(logger);
		expect(cleaned).toBe(1);
		expect(fs.existsSync(staleLockFile)).toBe(false);
	});

	it('should keep lockfiles for running processes', () => {
		const activeLockFile = path.join(copilotDir, 'active.lock');
		const activeLockInfo = {
			socketPath: '/tmp/test.sock',
			scheme: 'http',
			headers: {},
			pid: process.pid,
			ideName: 'Test',
			timestamp: Date.now(),
			workspaceFolders: [],
		};
		fs.writeFileSync(activeLockFile, JSON.stringify(activeLockInfo));

		expect(fs.existsSync(activeLockFile)).toBe(true);
		const cleaned = cleanupStaleLockFiles(logger);
		expect(cleaned).toBe(0);
		expect(fs.existsSync(activeLockFile)).toBe(true);
	});

	it('should return 0 when copilot directory does not exist', () => {
		fs.rmSync(copilotDir, { recursive: true, force: true });

		const cleaned = cleanupStaleLockFiles(logger);
		expect(cleaned).toBe(0);
	});
});
