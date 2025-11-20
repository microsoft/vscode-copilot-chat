/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, suite, test } from 'vitest';
import type { ChatPromptReference, TextDocument, Uri } from 'vscode';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ChatReferenceDiagnostic } from '../../../../../util/common/test/shims/chatTypes';
import { DiagnosticSeverity } from '../../../../../util/common/test/shims/enums';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { Location } from '../../../../../util/vs/workbench/api/common/extHostTypes/location';
import { Range } from '../../../../../util/vs/workbench/api/common/extHostTypes/range';
import { EndOfLine } from '../../../../../util/vs/workbench/api/common/extHostTypes/textEdit';
import { extractChatPromptReferences } from '../../../../agents/copilotcli/common/copilotCLIPrompt';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { TestChatRequest } from '../../../../test/node/testHelpers';
import { generateUserPrompt } from '../copilotCLIPrompt';


suite('parsePromptAttachments', () => {
	const disposables = new DisposableStore();
	let fileSystem: MockFileSystemService;
	let instaService: IInstantiationService;
	let workspaceService: TestWorkspaceService;
	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		fileSystem = accessor.get(IFileSystemService) as MockFileSystemService;
		workspaceService = accessor.get(IWorkspaceService) as TestWorkspaceService;
		instaService = accessor.get(IInstantiationService);
	});
	afterEach(() => {
		disposables.clear();
	});
	async function buildPrompt(raw: string, chatVariables?: ChatPromptReference[]): Promise<string> {
		// Set up instantiation service similar to other prompt tests
		const request = new TestChatRequest(raw);
		const prompt = await generateUserPrompt(request, new ChatVariablesCollection(chatVariables ?? []), instaService);
		return prompt;
	}
	test('returns empty when no attachments block', async () => {
		const prompt = await buildPrompt('hello world');
		const result = extractChatPromptReferences(prompt);
		expect(result.references.length).toBe(0);
		expect(result.diagnostics.length).toBe(0);
	});

	test('Files are attached with just references', async () => {
		const tsUri = URI.file('/workspace/file.ts');
		createMockFile(tsUri,
			`function add(a: number, b: number) {
			return a + b;
		}

		function subtract(a: number, b: number) {
			return a - b;
		}
		`);
		const pyUri = URI.file('/workspace/sample.py');
		createMockFile(pyUri,
			`deff add(a, b):
			return a + b;

		def subtract(a, b):
			return a - b
		`);
		const prompt = await buildPrompt('explain contents of #file:file.ts and other files', [
			{
				id: tsUri.toString(),
				name: 'file:file.ts',
				range: [20, 32],
				value: tsUri
			},
			{
				id: pyUri.toString(),
				name: 'sample.py',
				value: pyUri
			}
		]);

		const result = extractChatPromptReferences(prompt);
		// Self-closing <attachment ... /> tags for resources should now be parsed as locations.
		expect(result.references.length).toBeGreaterThanOrEqual(2);
		const names = result.references.map(l => l.name);
		expect(names).toContain('file:file.ts');
		expect(names).toContain('sample.py');
		// Diagnostics remain empty for pure resource references.
		expect(result.diagnostics.length).toBe(0);

		const tsFileRef = result.references.find(l => l.name === 'file:file.ts')!;
		expect(tsFileRef.range).toEqual([20, 32]);
		expect((tsFileRef.value as Uri).fsPath).toBe('/workspace/file.ts');

		const pyFileRef = result.references.find(l => l.name === 'sample.py')!;
		expect((pyFileRef.value as Uri).fsPath).toBe('/workspace/sample.py');
	});

	test('Folders are attached with just references', async () => {
		const folderUri = URI.file('/workspace/folder');
		fileSystem.mockDirectory(folderUri, [
			['file1.txt', FileType.File],
			['file2.txt', FileType.File],
		]);
		const prompt = await buildPrompt('list files in #file:folder', [
			{
				id: folderUri.toString(),
				name: 'file:folder',
				value: folderUri
			}
		]);

		const result = extractChatPromptReferences(prompt);
		// Self-closing <attachment ... /> tags for resources should now be parsed as locations.
		expect(result.references.length).toBe(1);
		const folderRef = result.references[0];
		expect(folderRef.name).toBe('file:folder');
		expect((folderRef.value as Uri).fsPath).toBe('/workspace/folder');
		expect(result.diagnostics.length).toBe(0);
	});

	test('parses single error diagnostic', async () => {
		const prompt = await buildPrompt('Fix this error', [
			{
				id: new Location(URI.file('/workspace/file.py'), new Range(12, 0, 12, 20)).toString(),
				name: 'Unterminated string',
				value: new ChatReferenceDiagnostic([
					[
						URI.file('/workspace/file.py'),
						[{
							message: 'Unterminated string',
							severity: DiagnosticSeverity.Error,
							range: new Range(12, 0, 12, 20),
							code: 'E001'
						}]
					]])
			}
		]);
		const result = extractChatPromptReferences(prompt);
		expect(result.diagnostics.length).toBe(1);
		const diagTuples = result.diagnostics[0].value.diagnostics;
		expect(diagTuples.length).toBe(1);
		expect(diagTuples[0][0].fsPath).toBe('/workspace/file.py');
		expect(diagTuples[0][1].length).toBe(1);
		expect(diagTuples[0][1][0].message).toMatch(/Unterminated string/);
		expect(diagTuples[0][1][0].code).toBe('E001');
		expect(diagTuples[0][1][0].range.start.line).toBe(12);
		expect(diagTuples[0][1][0].severity).toBe(DiagnosticSeverity.Error);
	});

	test('aggregates multiple errors across same and different files', async () => {
		const prompt = await buildPrompt('Fix these errors', [
			{
				id: new Location(URI.file('/workspace/file.py'), new Range(12, 0, 12, 20)).toString(),
				name: 'Unterminated string',
				value: new ChatReferenceDiagnostic([
					[
						URI.file('/workspace/file.py'),
						[
							{
								message: 'Msg1',
								severity: DiagnosticSeverity.Warning,
								range: new Range(1, 0, 1, 20),
								code: 'E001'
							},
							{
								message: 'MsgB',
								severity: DiagnosticSeverity.Error,
								range: new Range(4, 0, 4, 20),
								code: 'E002'
							},
						]
					],
					[
						URI.file('/workspace/sample.py'),
						[
							{
								message: 'Msg2',
								severity: DiagnosticSeverity.Warning,
								range: new Range(20, 0, 21, 10),
								code: 'W001'
							},
						]
					]])
			}
		]);

		const result = extractChatPromptReferences(prompt);
		let diagTuples = result.diagnostics[0].value.diagnostics;
		expect(diagTuples.length).toBe(1);
		expect(diagTuples[0][0].fsPath).toBe('/workspace/file.py');
		expect(diagTuples[0][1].length).toBe(1);
		expect(diagTuples[0][1][0].message).toMatch(/Msg1/);
		expect(diagTuples[0][1][0].code).toBe('E001');
		expect(diagTuples[0][1][0].range.start.line).toBe(1);
		expect(diagTuples[0][1][0].severity).toBe(DiagnosticSeverity.Warning);

		diagTuples = result.diagnostics[1].value.diagnostics;
		expect(diagTuples.length).toBe(1);
		expect(diagTuples[0][0].fsPath).toBe('/workspace/file.py');
		expect(diagTuples[0][1][0].message).toMatch(/MsgB/);
		expect(diagTuples[0][1][0].code).toBe('E002');
		expect(diagTuples[0][1][0].range.start.line).toBe(4);
		expect(diagTuples[0][1][0].severity).toBe(DiagnosticSeverity.Error);

		diagTuples = result.diagnostics[2].value.diagnostics;
		expect(diagTuples.length).toBe(1);
		expect(diagTuples[0][0].fsPath).toBe('/workspace/sample.py');
		expect(diagTuples[0][1].length).toBe(1);
		expect(diagTuples[0][1][0].message).toMatch(/Msg2/);
		expect(diagTuples[0][1][0].code).toBe('W001');
		expect(diagTuples[0][1][0].range.start.line).toBe(20);
		expect(diagTuples[0][1][0].severity).toBe(DiagnosticSeverity.Warning);
	});

	test('parses locations', async () => {
		const tsUri = URI.file('/workspace/file.ts');
		createMockFile(tsUri,
			`function add(a: number, b: number) {
			return a + b;
		}

		function subtract(a: number, b: number) {
			return a - b;
		}
		`);
		const pyUri = URI.file('/workspace/sample.py');
		createMockFile(pyUri,
			`deff add(a, b):
			return a + b;

		def subtract(a, b):
			return a - b
		`);
		const prompt = await buildPrompt('base', [
			{
				id: tsUri.toString(),
				name: 'file:file.ts',
				value: new Location(tsUri, new Range(4, 0, 4, 15))
			},
			{
				id: pyUri.toString(),
				name: 'file:sample.py',
				value: new Location(pyUri, new Range(3, 0, 3, 15))
			}
		]);
		const result = extractChatPromptReferences(prompt);
		expect(result.references.length).toBe(2);
		let loc = result.references[0].value as Location;
		expect(loc.uri.fsPath).toBe('/workspace/file.ts');
		expect(loc.range.start.line).toBe(4); // line numbers are 0-based internally
		expect(loc.range.end.line).toBe(4);
		loc = result.references[1].value as Location;
		expect(loc.uri.fsPath).toBe('/workspace/sample.py');
		expect(loc.range.start.line).toBe(3); // line numbers are 0-based internally
		expect(loc.range.end.line).toBe(3);
	});

	test('parses // filepath comment for typescript', async () => {
		const base = `<attachments>\n<attachment>Excerpt from /workspace/other.ts, lines 3 to 4:\n\n\`\`\`typescript\n// filepath: /workspace/other.ts\nconst x = 1;\nconst y = 2;\n\`\`\`\n</attachment>\n</attachments>`;
		const prompt = await buildPrompt(base);
		const result = extractChatPromptReferences(prompt);
		expect(result.references.length).toBe(1);
		const location = result.references[0].value as Location;
		expect(location.uri.fsPath).toBe('/workspace/other.ts');
		expect(location.range.start.line).toBe(2); // 3 -> zero-based
		expect(location.range.end.line).toBe(3); // 4 -> zero-based
	});

	test('uses attachment id attribute for name/id', async () => {
		const tsUri = URI.file('/workspace/add.py');
		createMockFile(tsUri,
			`# Basic arithmetic ops
		def add(a, b):
			return a + b
		}

		def subtract(a, b):
			return a - b
		`);
		const prompt = await buildPrompt('explain #sym:add', [
			{
				id: 'sym:add',
				name: 'sym:add',
				value: new Location(URI.file('/workspace/add.py'), new Range(1, 0, 3, 15)),
				range: [1, 3]
			}
		]);

		const result = extractChatPromptReferences(prompt);
		expect(result.references.length).toBe(1);
		const locObj = result.references[0];
		const location = locObj.value as Location;
		expect(location.uri.fsPath).toBe('/workspace/add.py');
		expect(locObj.name).toBe('sym:add');
		expect(locObj.range).toEqual([8, 15]);
		expect(location.range.start.line).toBe(1); // 2 -> zero-based
		expect(location.range.end.line).toBe(3); // 4 -> zero-based
	});

	test('parses attachment using only # filepath comment', async () => {
		const base = `<attachments>\n<attachment>Random header\n\n\`\`\`python\n# filepath: /workspace/only.py\nprint('hi')\n\`\`\`\n</attachment>\n</attachments>`;
		const prompt = await buildPrompt(base);
		const result = extractChatPromptReferences(prompt);
		expect(result.references.length).toBe(0); // no excerpt with line numbers, cannot build location
	});

	function createMockFile(uri: URI, text: string) {
		const doc = {
			uri,
			getText: (range?: Range) => range ? extractTextFromRange(text, range) : text,
			lineCount: text.split(/\r\n|\r|\n/g).length,
			eol: EndOfLine.LF,
			version: 1,
			languageId: 'plaintext'
		} as unknown as TextDocument;
		workspaceService.textDocuments.push(doc);
		fileSystem.mockFile(uri, text);
	}
	function extractTextFromRange(text: string, range: Range): string {
		const lines = text.split(/\r\n|\r|\n/g);
		return lines.slice(range.start.line, range.end.line + 1).join('\n');
	}
});