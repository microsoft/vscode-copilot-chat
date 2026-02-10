/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTerminals } = vi.hoisted(() => ({
	mockTerminals: { value: [] as Array<{ processId: Promise<number | undefined>; name: string }> },
}));

vi.mock('vscode', async (importOriginal) => {
	const actual = await importOriginal() as Record<string, unknown>;
	return {
		...actual,
		window: {
			get terminals() { return mockTerminals.value; },
		},
	};
});

import { CopilotCLISessionTracker } from '../copilotCLISessionTracker';

describe('CopilotCLISessionTracker', () => {
	let tracker: CopilotCLISessionTracker;

	beforeEach(() => {
		tracker = new CopilotCLISessionTracker();
		mockTerminals.value = [];
	});

	describe('registerSession', () => {
		it('should register a session with pid and ppid', () => {
			const disposable = tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			expect(disposable).toBeDefined();
			expect(disposable.dispose).toBeInstanceOf(Function);
		});

		it('should allow registering multiple sessions', () => {
			tracker.registerSession('session-1', { pid: 1000, ppid: 2000 });
			tracker.registerSession('session-2', { pid: 3000, ppid: 4000 });

			// Both should be registered (verified via getTerminal not returning undefined for known ppid)
			mockTerminals.value = [
				{ processId: Promise.resolve(2000), name: 'terminal-1' },
				{ processId: Promise.resolve(4000), name: 'terminal-2' },
			];
		});

		it('should remove session on dispose', async () => {
			const disposable = tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			mockTerminals.value = [
				{ processId: Promise.resolve(5678), name: 'terminal-1' },
			];

			// Terminal should be found before dispose
			const terminalBefore = await tracker.getTerminal('session-1');
			expect(terminalBefore).toBeDefined();

			disposable.dispose();

			// Terminal should not be found after dispose
			const terminalAfter = await tracker.getTerminal('session-1');
			expect(terminalAfter).toBeUndefined();
		});

		it('should overwrite existing session with same id', async () => {
			tracker.registerSession('session-1', { pid: 1000, ppid: 2000 });
			tracker.registerSession('session-1', { pid: 3000, ppid: 4000 });

			mockTerminals.value = [
				{ processId: Promise.resolve(2000), name: 'terminal-old' },
				{ processId: Promise.resolve(4000), name: 'terminal-new' },
			];

			const terminal = await tracker.getTerminal('session-1');
			// Should match the new ppid (4000), not the old one (2000)
			expect(terminal).toBeDefined();
			expect((terminal as { name: string }).name).toBe('terminal-new');
		});
	});

	describe('getTerminal', () => {
		it('should return undefined for unknown session', async () => {
			const terminal = await tracker.getTerminal('unknown-session');
			expect(terminal).toBeUndefined();
		});

		it('should return undefined when no terminals exist', async () => {
			tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			mockTerminals.value = [];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBeUndefined();
		});

		it('should find terminal matching session ppid', async () => {
			tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			const expectedTerminal = { processId: Promise.resolve(5678), name: 'matching-terminal' };
			mockTerminals.value = [
				{ processId: Promise.resolve(1111), name: 'other-terminal' },
				expectedTerminal,
				{ processId: Promise.resolve(9999), name: 'another-terminal' },
			];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBe(expectedTerminal);
		});

		it('should return undefined when no terminal matches ppid', async () => {
			tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			mockTerminals.value = [
				{ processId: Promise.resolve(1111), name: 'terminal-1' },
				{ processId: Promise.resolve(2222), name: 'terminal-2' },
			];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBeUndefined();
		});

		it('should handle terminals with undefined processId', async () => {
			tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			mockTerminals.value = [
				{ processId: Promise.resolve(undefined as unknown as number), name: 'no-pid-terminal' },
				{ processId: Promise.resolve(5678), name: 'matching-terminal' },
			];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBeDefined();
			expect((terminal as { name: string }).name).toBe('matching-terminal');
		});

		it('should return first matching terminal when multiple match', async () => {
			tracker.registerSession('session-1', { pid: 1234, ppid: 5678 });
			const firstMatch = { processId: Promise.resolve(5678), name: 'first-match' };
			const secondMatch = { processId: Promise.resolve(5678), name: 'second-match' };
			mockTerminals.value = [firstMatch, secondMatch];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBe(firstMatch);
		});

		it('should find correct terminal for different sessions', async () => {
			tracker.registerSession('session-1', { pid: 1000, ppid: 2000 });
			tracker.registerSession('session-2', { pid: 3000, ppid: 4000 });

			const terminal1 = { processId: Promise.resolve(2000), name: 'terminal-for-session-1' };
			const terminal2 = { processId: Promise.resolve(4000), name: 'terminal-for-session-2' };
			mockTerminals.value = [terminal1, terminal2];

			const result1 = await tracker.getTerminal('session-1');
			const result2 = await tracker.getTerminal('session-2');
			expect(result1).toBe(terminal1);
			expect(result2).toBe(terminal2);
		});
	});

	describe('dispose lifecycle', () => {
		it('disposing first registration does not affect second registration with different id', async () => {
			const disposable1 = tracker.registerSession('session-1', { pid: 1000, ppid: 2000 });
			tracker.registerSession('session-2', { pid: 3000, ppid: 4000 });

			disposable1.dispose();

			mockTerminals.value = [
				{ processId: Promise.resolve(4000), name: 'terminal-2' },
			];

			// session-1 should be gone
			const terminal1 = await tracker.getTerminal('session-1');
			expect(terminal1).toBeUndefined();

			// session-2 should still work
			const terminal2 = await tracker.getTerminal('session-2');
			expect(terminal2).toBeDefined();
		});

		it('disposing overwritten registration removes the session', async () => {
			const disposable1 = tracker.registerSession('session-1', { pid: 1000, ppid: 2000 });
			const disposable2 = tracker.registerSession('session-1', { pid: 3000, ppid: 4000 });

			// Disposing the second registration should remove the session
			disposable2.dispose();

			mockTerminals.value = [
				{ processId: Promise.resolve(4000), name: 'terminal-new' },
			];

			const terminal = await tracker.getTerminal('session-1');
			expect(terminal).toBeUndefined();

			// Disposing the first (already overwritten) should be a no-op
			disposable1.dispose();
		});
	});
});
