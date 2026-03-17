/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from 'vscode';
import { MockSessionTracker } from '../../copilotcli/vscode-node/test/testHelpers';
import { resolveSessionDirsForTerminal } from '../copilotCLIChatSessionsContribution';

// The contribution file transitively imports a .ps1 asset via this module
// which Vitest cannot parse. Stub out the module entirely — only the service
// identifier is referenced at import time.
vi.mock('../copilotCLITerminalIntegration', () => {
	const createServiceIdentifier = (name: string) => {
		const fn = (() => { /* decorator no-op */ }) as { toString(): string };
		fn.toString = () => name;
		return fn;
	};
	return {
		ICopilotCLITerminalIntegration: createServiceIdentifier('ICopilotCLITerminalIntegration'),
	};
});

// Deterministic session-state path independent of the host homedir / XDG_STATE_HOME.
vi.mock('../../copilotcli/node/cliHelpers', async importOriginal => {
	const actual = await importOriginal<typeof import('../../copilotcli/node/cliHelpers')>();
	return {
		...actual,
		getCopilotCLISessionDir: (sessionId: string) => `/mock/session-state/${sessionId}`,
	};
});

// Provide Uri + everything else the contribution module imports at top level.
vi.mock('vscode', async () => {
	const actual = await import('../../../../vscodeTypes');
	return {
		...actual,
		env: { appName: 'VS Code' },
		version: 'test',
		extensions: { getExtension: vi.fn(() => ({ packageJSON: { version: 'test' } })) },
	};
});

// --- Helpers -------------------------------------------------------------

class MockTerminal {
	readonly processId = Promise.resolve(123);
	readonly name = 'test';
	readonly creationOptions = {};
	readonly exitStatus = undefined;
	readonly state = { isInteractedWith: false, shell: undefined };
	readonly selection = undefined;
	readonly shellIntegration = undefined;
	sendText() { }
	show() { }
	hide() { }
	dispose() { }
}

function makeTerminal(): Terminal {
	return new MockTerminal() as Terminal;
}

// --- Tests ---------------------------------------------------------------

// Regression coverage for https://github.com/microsoft/vscode/issues/301594.
// The link provider assumes the resolver orders dirs by terminal affinity;
// these tests pin that ordering so it can't silently regress.
describe('resolveSessionDirsForTerminal', () => {
	let tracker: MockSessionTracker;
	let terminalA: Terminal;
	let terminalB: Terminal;

	beforeEach(() => {
		tracker = new MockSessionTracker();
		terminalA = makeTerminal();
		terminalB = makeTerminal();
	});

	it('returns terminal-matched sessions before unrelated ones', async () => {
		// Two sessions: X lives in terminal A, Y lives in terminal B.
		tracker.setSessionName('session-x', 'X');
		tracker.setSessionName('session-y', 'Y');
		tracker.getTerminal.mockImplementation(async (id: string) => {
			switch (id) {
				case 'session-x': return terminalA;
				case 'session-y': return terminalB;
				default: return undefined;
			}
		});

		const dirsForA = await resolveSessionDirsForTerminal(tracker.asTracker(), terminalA);
		expect(dirsForA.map(d => d.fsPath)).toEqual([
			'/mock/session-state/session-x', // match first
			'/mock/session-state/session-y', // rest after
		]);

		const dirsForB = await resolveSessionDirsForTerminal(tracker.asTracker(), terminalB);
		expect(dirsForB.map(d => d.fsPath)).toEqual([
			'/mock/session-state/session-y',
			'/mock/session-state/session-x',
		]);
	});

	it('still returns sessions whose terminal cannot be resolved', async () => {
		// Early in a CLI run the tracker may not have matched the PID tree yet.
		// Session Y has no resolved terminal; it must land in rest[] so the
		// link provider can still probe its dir by file existence.
		tracker.setSessionName('session-x', 'X');
		tracker.setSessionName('session-y', 'Y');
		tracker.getTerminal.mockImplementation(async (id: string) =>
			id === 'session-x' ? terminalA : undefined
		);

		const dirs = await resolveSessionDirsForTerminal(tracker.asTracker(), terminalA);
		expect(dirs.map(d => d.fsPath)).toEqual([
			'/mock/session-state/session-x',
			'/mock/session-state/session-y',
		]);
	});

	it('returns only rest when no session matches the terminal', async () => {
		// Unregistered terminal — all sessions should still be offered so
		// _resolvePath can probe each one.
		tracker.setSessionName('session-x', 'X');
		tracker.setSessionName('session-y', 'Y');
		tracker.getTerminal.mockImplementation(async (id: string) =>
			id === 'session-x' ? terminalA : terminalB
		);

		const unknownTerminal = makeTerminal();
		const dirs = await resolveSessionDirsForTerminal(tracker.asTracker(), unknownTerminal);
		expect(dirs.map(d => d.fsPath)).toEqual([
			'/mock/session-state/session-x',
			'/mock/session-state/session-y',
		]);
	});

	it('returns empty when no sessions are active', async () => {
		const dirs = await resolveSessionDirsForTerminal(tracker.asTracker(), terminalA);
		expect(dirs).toEqual([]);
	});
});
