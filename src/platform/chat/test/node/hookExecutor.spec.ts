/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import type { ChatHookCommand } from 'vscode';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { TestLogService } from '../../../testing/common/testLogService';
import { HookCommandResultKind } from '../../common/hookExecutor';
import { NodeHookExecutor } from '../../node/hookExecutor';

function cmd(command: string, options?: Partial<Omit<ChatHookCommand, 'command'>>): ChatHookCommand {
	return { command, ...options } as ChatHookCommand;
}

describe('NodeHookExecutor', () => {
	let executor: NodeHookExecutor;

	beforeEach(() => {
		executor = new NodeHookExecutor(new TestLogService());
	});

	test('runs command and returns success result', async () => {
		const result = await executor.executeCommand(
			cmd('echo "hello world"'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		expect((result.result as string).trim()).toBe('hello world');
	});

	test('parses JSON output', async () => {
		const result = await executor.executeCommand(
			cmd('echo \'{"key": "value"}\''),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		expect(result.result).toEqual({ key: 'value' });
	});

	test('returns non-blocking error for exit code 1', async () => {
		const result = await executor.executeCommand(
			cmd('exit 1'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.NonBlockingError);
	});

	test('returns blocking error for exit code 2', async () => {
		const result = await executor.executeCommand(
			cmd('exit 2'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Error);
	});

	test('captures stderr on failure', async () => {
		const result = await executor.executeCommand(
			cmd('echo "error message" >&2 && exit 1'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.NonBlockingError);
		expect((result.result as string).trim()).toBe('error message');
	});

	test('passes input to stdin as JSON', async () => {
		const input = { tool: 'bash', args: { command: 'ls' } };
		const result = await executor.executeCommand(
			cmd('cat'),
			input,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		expect(result.result).toEqual(input);
	});

	test('returns error for invalid command', async () => {
		const result = await executor.executeCommand(
			cmd('/nonexistent/command/that/does/not/exist'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.NonBlockingError);
	});

	test('uses custom environment variables', async () => {
		const result = await executor.executeCommand(
			cmd('echo $MY_VAR', { env: { MY_VAR: 'custom_value' } }),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		expect((result.result as string).trim()).toBe('custom_value');
	});

	test('uses custom cwd', async () => {
		const result = await executor.executeCommand(
			cmd('pwd', { cwd: URI.file('/tmp') }),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		// macOS uses /private/tmp symlink
		expect((result.result as string).trim()).toMatch(/tmp/);
	});

	test('converts URI-like objects in input to filesystem paths', async () => {
		const input = {
			cwd: { scheme: 'file', path: '/test/path', fsPath: '/test/path' },
			other: 'value'
		};
		const result = await executor.executeCommand(
			cmd('cat'),
			input,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		const parsed = result.result as Record<string, unknown>;
		expect(parsed['cwd']).toBe('/test/path');
		expect(parsed['other']).toBe('value');
	});

	test('handles null and undefined input without error', async () => {
		const resultNull = await executor.executeCommand(
			cmd('echo ok'),
			null,
			CancellationToken.None
		);
		expect(resultNull.kind).toBe(HookCommandResultKind.Success);

		const resultUndefined = await executor.executeCommand(
			cmd('echo ok'),
			undefined,
			CancellationToken.None
		);
		expect(resultUndefined.kind).toBe(HookCommandResultKind.Success);
	});

	test('returns empty string for command with no output', async () => {
		const result = await executor.executeCommand(
			cmd('true'),
			undefined,
			CancellationToken.None
		);

		expect(result.kind).toBe(HookCommandResultKind.Success);
		expect(result.result).toBe('');
	});

	test('respects cancellation token', async () => {
		const cts = new CancellationTokenSource();

		// Start a long-running command
		const resultPromise = executor.executeCommand(
			cmd('sleep 30'),
			undefined,
			cts.token
		);

		// Cancel after a short delay
		setTimeout(() => cts.cancel(), 100);

		const result = await resultPromise;
		// Command should be killed, resulting in non-blocking error (non-zero exit)
		expect(result.kind).toBe(HookCommandResultKind.NonBlockingError);
	});

	test('respects timeout', async () => {
		const result = await executor.executeCommand(
			cmd('sleep 30', { timeoutSec: 1 }),
			undefined,
			CancellationToken.None
		);

		// Command should be killed after timeout
		expect(result.kind).toBe(HookCommandResultKind.NonBlockingError);
	});
});
