/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken, Terminal, TerminalLinkContext, Uri } from 'vscode';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CopilotCLITerminalLinkProvider } from '../copilotCLITerminalLinkProvider';

// --- Mocks ---------------------------------------------------------------

const mockStat = vi.hoisted(() => vi.fn());
const mockWorkspaceFolders = vi.hoisted(() => ({ value: undefined as { uri: { fsPath: string; scheme: string } }[] | undefined }));

vi.mock('vscode', () => ({
	Uri: {
		file: (path: string) => ({
			fsPath: path,
			scheme: 'file',
			toString: (skipEncoding?: boolean) => skipEncoding ? `file://${path}` : `file://${encodeURI(path)}`,
		}),
		joinPath: (base: { fsPath: string; scheme: string }, ...segments: string[]) => {
			const joined = [base.fsPath, ...segments].join('/');
			return {
				fsPath: joined,
				scheme: base.scheme,
				toString: (skipEncoding?: boolean) => skipEncoding ? `file://${joined}` : `file://${encodeURI(joined)}`,
			};
		},
	},
	Range: class Range {
		constructor(
			public readonly startLine: number,
			public readonly startCharacter: number,
			public readonly endLine: number,
			public readonly endCharacter: number,
		) { }
	},
	window: {
		showTextDocument: vi.fn(),
	},
	workspace: {
		fs: { stat: mockStat },
		get workspaceFolders() {
			return mockWorkspaceFolders.value;
		},
	},
}));

vi.mock('os', () => ({
	homedir: () => '/Users/anthonykim',
}));

// --- Helpers -------------------------------------------------------------

const SESSION_UUID = 'ak1234fe-ae47-4c68-8123-f4adef123123';
const SESSION_DIR = `/Users/anthonykim/.copilot/session-state/${SESSION_UUID}`;

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

function makeContext(line: string, terminal: Terminal): TerminalLinkContext {
	return { line, terminal };
}

function makeToken(): CancellationToken {
	return { isCancellationRequested: false, onCancellationRequested: vi.fn() } as CancellationToken;
}

// --- Tests ---------------------------------------------------------------

describe('CopilotCLITerminalLinkProvider', () => {
	let provider: CopilotCLITerminalLinkProvider;
	let terminal: Terminal;
	let sessionDirUri: Uri;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockWorkspaceFolders.value = undefined;
		const vscode = await import('vscode');

		provider = new CopilotCLITerminalLinkProvider(new TestLogService());
		terminal = makeTerminal();
		sessionDirUri = vscode.Uri.file(SESSION_DIR);

		provider.registerTerminal(terminal);
		provider.setSessionDir(terminal, sessionDirUri);

		// By default, stat succeeds (file exists).
		mockStat.mockResolvedValue({ type: 1 });
	});

	describe('relative paths', () => {
		it('should detect files/sample-summary.md', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('  Relative: files/sample-summary.md', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('files/sample-summary.md');
			expect(links[0].uri?.fsPath).toBe(`${SESSION_DIR}/files/sample-summary.md`);
		});

		it('should detect bare files/sample-summary.md at start of line', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('files/sample-summary.md', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('files/sample-summary.md');
		});

		it('should detect dot-prefixed ./files/sample-summary.md', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('./files/sample-summary.md', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('./files/sample-summary.md');
		});
	});

	describe('tilde paths', () => {
		it('should expand ~/.copilot/session-state/.../files/sample-summary.md', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext(`  Absolute: ~/.copilot/session-state/${SESSION_UUID}/files/sample-summary.md`, terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toContain('~/.copilot/session-state');
			expect(links[0].uri?.fsPath).toBe(`/Users/anthonykim/.copilot/session-state/${SESSION_UUID}/files/sample-summary.md`);
		});
	});

	describe('absolute paths', () => {
		it('should skip /Users/anthonykim/.copilot/.../files/sample-summary.md', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext(`  /Users/anthonykim/.copilot/session-state/${SESSION_UUID}/files/sample-summary.md`, terminal),
				makeToken(),
			);
			// Absolute paths are skipped — the built-in detector handles them.
			expect(links).toHaveLength(0);
		});
	});

	describe('trailing punctuation', () => {
		it('should strip trailing period from files/sample-summary.md.', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('file at files/sample-summary.md.', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('files/sample-summary.md');
		});

		it('should strip multiple trailing dots', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('files/sample-summary.md...', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('files/sample-summary.md');
		});
	});

	describe('line and column suffixes', () => {
		it('should parse :line:col suffix', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('src/foo/bar.ts:10:5', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('src/foo/bar.ts');
			expect(links[0].line).toBe(10);
			expect(links[0].col).toBe(5);
		});

		it('should parse (line, col) suffix', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('src/foo/bar.ts(42, 7)', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].line).toBe(42);
			expect(links[0].col).toBe(7);
		});
	});

	describe('URLs', () => {
		it('should skip https:// URLs', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('Visit https://example.com/path for info', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(0);
		});
	});

	describe('guards', () => {
		it('should return empty for blank lines', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('   ', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(0);
		});

		it('should return empty for lines over 2000 chars', async () => {
			const longLine = 'files/summary.md ' + 'x'.repeat(2000);
			const links = await provider.provideTerminalLinks(
				makeContext(longLine, terminal),
				makeToken(),
			);
			expect(links).toHaveLength(0);
		});

		it('should cap links at 10 per line', async () => {
			const paths = Array.from({ length: 15 }, (_, i) => `dir/file${i}.ts`).join(' ');
			const links = await provider.provideTerminalLinks(
				makeContext(paths, terminal),
				makeToken(),
			);
			expect(links.length).toBeLessThanOrEqual(10);
		});

		it('should skip unregistered terminals with no session dirs', async () => {
			const unknownTerminal = makeTerminal();
			const links = await provider.provideTerminalLinks(
				makeContext('files/summary.md', unknownTerminal),
				makeToken(),
			);
			expect(links).toHaveLength(0);
		});
	});

	describe('session dir resolution', () => {
		it('should resolve via session dir resolver when no cached dir', async () => {
			const vscode = await import('vscode');
			const freshTerminal = makeTerminal();
			provider.registerTerminal(freshTerminal);
			provider.setSessionDirResolver(async _t => [vscode.Uri.file(SESSION_DIR)]);

			const links = await provider.provideTerminalLinks(
				makeContext('files/demo.md', freshTerminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].uri?.fsPath).toBe(`${SESSION_DIR}/files/demo.md`);
		});

		it('should fall back to workspace folders when file not in session dir', async () => {
			const vscode = await import('vscode');
			// stat fails for session dir, succeeds for workspace
			mockStat.mockRejectedValueOnce(new Error('not found'))
				.mockResolvedValueOnce({ type: 1 });

			mockWorkspaceFolders.value = [{ uri: vscode.Uri.file('/workspace/project') }];

			const links = await provider.provideTerminalLinks(
				makeContext('src/index.ts', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].uri?.fsPath).toBe('/workspace/project/src/index.ts');
		});
	});

	describe('extensionless files', () => {
		it('should detect dir/Makefile', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('dir/Makefile', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('dir/Makefile');
		});
	});

	describe('Windows paths', () => {
		it('should detect backslash relative paths', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('files\\sample-summary.md', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].pathText).toBe('files\\sample-summary.md');
		});

		it('should expand tilde with backslash (~\\.copilot\\...)', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('Create ~\\.copilot\\session-state\\5d9e\\files\\sample-summary.md (+4)', terminal),
				makeToken(),
			);
			expect(links).toHaveLength(1);
			expect(links[0].uri?.fsPath).toContain('/Users/anthonykim');
			expect(links[0].uri?.fsPath).toContain('.copilot');
		});

		it('should skip Windows absolute paths (C:\\...)', async () => {
			const links = await provider.provideTerminalLinks(
				makeContext('Absolute: C:\\Users\\antho\\.copilot\\files\\sample-summary.md', terminal),
				makeToken(),
			);
			// C:\... matched as \Users\... which starts with \ and is skipped.
			expect(links).toHaveLength(0);
		});
	});
});
