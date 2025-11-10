/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../../util/vs/base/common/path';
import { URI } from '../../../../../util/vs/base/common/uri';
import { ChatReferenceDiagnostic, Diagnostic, DiagnosticSeverity, FileType, Range } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { TestChatRequest } from '../../../../test/node/testHelpers';
import { CopilotCLIPromptResolver } from '../copilotcliPromptResolver';

function makeDiagnostic(line: number, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error, code?: string): Diagnostic {
	const diag = new Diagnostic(
		new Range(line, 0, line, 0),
		message,
		severity
	);
	diag.code = code;
	return diag;
}

// Helper to create a ChatRequest with references array patched
function withReferences(req: TestChatRequest, refs: unknown[]): TestChatRequest {
	// vitest doesn't prevent mutation; emulate the readonly property by assignment cast
	req.references = refs as vscode.ChatPromptReference[];
	return req;
}

describe('CopilotCLIPromptResolver', () => {
	const store = new DisposableStore();
	let resolver: CopilotCLIPromptResolver;
	let fileSystemService: IFileSystemService;
	let logService: ILogService;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		fileSystemService = new MockFileSystemService();
		logService = accessor.get(ILogService);
		resolver = new CopilotCLIPromptResolver(logService, fileSystemService);
	});

	afterEach(() => {
		store.clear();
		vi.resetAllMocks();
	});

	it('returns original prompt unchanged for slash command', async () => {
		const req = new TestChatRequest('/help something');
		const { prompt, attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);
		expect(prompt).toBe('/help something');
		expect(attachments).toHaveLength(0);
	});

	it('collects file references and produces attachments plus reminder block', async () => {
		// Spy on stat to simulate file type
		const statSpy = vi.spyOn(fileSystemService, 'stat').mockResolvedValue({ type: FileType.File, size: 10 } as any);

		const fileA = URI.file(path.join('tmp', 'a.ts'));
		const fileB = URI.file(path.join('tmp', 'b.ts'));

		const req = withReferences(new TestChatRequest('Explain a and b'), [
			{ id: 'file-a', value: fileA, name: 'a.ts', range: [8, 9] }, // 'a'
			{ id: 'file-b', value: fileB, name: 'b.ts', range: [14, 15] } // 'b'
		]);

		const { prompt, attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);

		// Should have reminder block
		expect(prompt).toMatch(/<reminder>/);
		expect(prompt).toMatch(/The user provided the following references:/);
		expect(prompt).toContain(`- a → ${fileA.fsPath}`);
		expect(prompt).toContain(`- b → ${fileB.fsPath}`);

		// Attachments reflect both files
		expect(attachments.map(a => a.displayName).sort()).toEqual(['a.ts', 'b.ts']);
		expect(attachments.every(a => a.type === 'file')).toBe(true);
		// Stat called for each file
		expect(statSpy).toHaveBeenCalledTimes(2);
	});

	it('includes diagnostics in reminder block with severity and line', async () => {
		const statSpy = vi.spyOn(fileSystemService, 'stat').mockResolvedValue({ type: FileType.File, size: 10 } as any);
		const fileUri = URI.file(path.join('workspace', 'src', 'index.ts'));

		const diagnostics = [
			makeDiagnostic(4, 'Unexpected any', 0, 'TS7005'),
			makeDiagnostic(9, 'Possible undefined', 1)
		];

		// ChatReferenceDiagnostic requires a Map of uri -> diagnostics array
		const chatRefDiag: ChatReferenceDiagnostic = { diagnostics: [[fileUri, diagnostics]] };
		const req = withReferences(new TestChatRequest('Fix issues'), [
			{ id: 'diag-1', value: chatRefDiag }
		]);

		const { prompt, attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);

		expect(prompt).toMatch(/Fix issues/);
		expect(prompt).toMatch(/The user provided the following diagnostics:/);
		expect(prompt).toContain(`- error [TS7005] at ${fileUri.fsPath}:5: Unexpected any`);
		expect(prompt).toContain(`- warning at ${fileUri.fsPath}:10: Possible undefined`);
		// File should be attached once
		expect(attachments).toHaveLength(1);
		expect(attachments[0].path).toBe(fileUri.fsPath);
		expect(statSpy).toHaveBeenCalledTimes(1);
	});

	it('attaches directories correctly', async () => {
		const statSpy = vi.spyOn(fileSystemService, 'stat').mockResolvedValueOnce({ type: FileType.Directory, size: 0 } as any);
		const dirUri = URI.file('/workspace/src');
		const req = withReferences(new TestChatRequest('List src'), [
			{ id: 'src-dir', value: dirUri, name: 'src', range: [5, 8] }
		]);

		const { attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);
		expect(attachments).toHaveLength(1);
		expect(attachments[0].type).toBe('directory');
		expect(attachments[0].displayName).toBe('src');
		expect(statSpy).toHaveBeenCalledTimes(1);
	});

	it('logs and ignores non file/directory stat types', async () => {
		// Simulate an unknown type (e.g., FileType.SymbolicLink or other)
		const statSpy = vi.spyOn(fileSystemService, 'stat').mockResolvedValue({ type: 99, size: 0 } as any);
		const logSpy = vi.spyOn(logService, 'error').mockImplementation(() => { });
		const badUri = URI.file('/workspace/unknown');
		const req = withReferences(new TestChatRequest('Check unknown'), [
			{ id: 'bad', value: badUri, name: 'unknown', range: [6, 13] }
		]);

		const { attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);
		expect(attachments).toHaveLength(0); // ignored
		expect(statSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalled();
	});

	it('handles stat failure gracefully and logs error', async () => {
		const error = new Error('stat failed');
		const statSpy = vi.spyOn(fileSystemService, 'stat').mockRejectedValue(error);
		const logSpy = vi.spyOn(logService, 'error').mockImplementation(() => { });
		const fileUri = URI.file('/workspace/src/index.ts');
		const req = withReferences(new TestChatRequest('Read file'), [
			{ id: 'file', value: fileUri, name: 'index.ts', range: [5, 10] }
		]);

		const { attachments } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);
		expect(attachments).toHaveLength(0);
		expect(statSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalled();
	});

	it('no reminder block when there are no references or diagnostics', async () => {
		const req = new TestChatRequest('Just a question');
		const { prompt } = await resolver.resolvePrompt(req as unknown as vscode.ChatRequest, CancellationToken.None);
		expect(prompt).toBe('Just a question');
	});
});
