/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment } from '@github/copilot/sdk';
import { afterEach, beforeEach, expect, suite, test, vi } from 'vitest';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { IIgnoreService } from '../../../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ChatReferenceDiagnostic } from '../../../../../util/common/test/shims/chatTypes';
import { DiagnosticSeverity } from '../../../../../util/common/test/shims/enums';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../../../util/vs/base/common/network';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { Location } from '../../../../../util/vs/workbench/api/common/extHostTypes/location';
import { Range } from '../../../../../util/vs/workbench/api/common/extHostTypes/range';
import { extractChatPromptReferences } from '../../../../agents/copilotcli/common/copilotCLIPrompt';
import { CopilotCLIPromptResolver } from '../../../../agents/copilotcli/node/copilotcliPromptResolver';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { TestChatRequest } from '../../../../test/node/testHelpers';


suite('CopilotCLI Generate & parse prompts', () => {
	const disposables = new DisposableStore();
	let fileSystem: MockFileSystemService;
	let instaService: IInstantiationService;
	let workspaceService: TestWorkspaceService;
	let resolver: CopilotCLIPromptResolver;
	beforeEach(() => {
		const services = createExtensionUnitTestingServices(disposables);
		const accessor = disposables.add(services.createTestingAccessor());
		fileSystem = accessor.get(IFileSystemService) as MockFileSystemService;
		workspaceService = accessor.get(IWorkspaceService) as TestWorkspaceService;
		instaService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);
		resolver = new CopilotCLIPromptResolver(logService, fileSystem, services.seal(), accessor.get(IIgnoreService));
	});
	afterEach(() => {
		disposables.clear();
		vi.resetAllMocks();
	});
	test('just the prompt without anything else', async () => {
		const req = new TestChatRequest('hello world');
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('returns original prompt unchanged for slash command', async () => {
		const req = new TestChatRequest('/help something');
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();

	});

	test('returns overridden prompt instead of using the request prompt', async () => {
		const req = new TestChatRequest('/help something');
		const resolved = await resolver.resolvePrompt(req, 'What is 1+2', [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('files are attached as just references without content', async () => {
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

		const req = new TestChatRequest('explain contents of #file:file.ts and other files', [
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
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});
	test('Folders are attached with just references', async () => {
		const folderUri = URI.file('/workspace/folder');
		fileSystem.mockDirectory(folderUri, [
			['file1.txt', FileType.File],
			['file2.txt', FileType.File],
		]);
		const req = new TestChatRequest('list files in #file:folder', [
			{
				id: folderUri.toString(),
				name: 'file:folder',
				value: folderUri
			}
		]);
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('parses single error diagnostic', async () => {
		const req = new TestChatRequest('Fix this error', [
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
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('aggregates multiple errors across same and different files', async () => {
		const req = new TestChatRequest('Fix these errors', [
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

		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});
	test('parses locations includeing files with spaces', async () => {
		const tsUri = URI.file('/workspace/file.ts');
		createMockFile(tsUri,
			`function add(a: number, b: number) {
				return a + b;
			}

			function subtract(a: number, b: number) {
				return a - b;
			}
			`);
		const tsWithSpacesUri = URI.file('/workspace/hello world/sample.ts');
		createMockFile(tsWithSpacesUri,
			`function mod(a: number) {
				return a;
			}`);
		const pyUri = URI.file('/workspace/sample.py');
		createMockFile(pyUri,
			`deff add(a, b):
				return a + b;

			def subtract(a, b):
				return a - b
			`);
		const req = new TestChatRequest('base', [
			{
				id: tsUri.toString(),
				name: 'file:file.ts',
				value: new Location(tsWithSpacesUri, new Range(4, 0, 4, 15))
			},
			{
				id: tsWithSpacesUri.toString(),
				name: 'file:sample.ts',
				value: new Location(tsWithSpacesUri, new Range(4, 0, 4, 15))
			},
			{
				id: pyUri.toString(),
				name: 'file:sample.py',
				value: new Location(pyUri, new Range(3, 0, 3, 15))
			}
		]);
		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
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
		const req = new TestChatRequest('explain #sym:add', [
			{
				id: 'sym:add',
				name: 'sym:add',
				value: new Location(URI.file('/workspace/add.py'), new Range(1, 0, 3, 15)),
				range: [1, 3]
			}
		]);

		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('includes contents of untitled file', async () => {
		const untitledTsFile = {
			id: 'file:untitled-1',
			name: 'file:untitled-1',
			value: URI.from({ scheme: Schemas.untitled, path: 'untitled-1' })
		};
		createMockFile(untitledTsFile.value, `function example() {
	console.log("This is an example");
}`);
		const req = new TestChatRequest('Process these files', [
			untitledTsFile
		]);

		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('includes contents of untitled prompt files', async () => {
		const untitledPromptFile = {
			id: 'vscode.prompt.file__untitled:untitled-1',
			name: 'prompt:Untitled-2',
			value: URI.from({ scheme: Schemas.untitled, path: '/untitled-1' })
		};
		const regularFileRef = {
			id: 'regular-file',
			name: 'regular.ts',
			value: URI.file('/workspace/regular.ts')
		};
		createMockFile(untitledPromptFile.value, `This is a prompt file`);

		const req = new TestChatRequest('Process these files', [
			untitledPromptFile,
			regularFileRef
		]);

		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});

	test('includes contents of regular prompt files', async () => {
		const promptFile = {
			id: 'vscode.prompt.file__file:doit.prompt.md',
			name: 'prompt:doit.prompt.md',
			value: URI.file('doit.prompt.md')
		};
		createMockFile(promptFile.value, `This is a prompt file`);

		const req = new TestChatRequest('Process these files', [
			promptFile
		]);

		const resolved = await resolver.resolvePrompt(req, undefined, [], CancellationToken.None);

		const result = extractChatPromptReferences(resolved.prompt);
		expect(resolved.prompt).toMatchSnapshot();
		expect(fixFilePathsForTestComparison(resolved.attachments)).toMatchSnapshot();
		expect(result).toMatchSnapshot();
	});
	function createMockFile(uri: URI, text: string) {
		const doc = createTextDocumentData(uri, text, 'plaintext', '\n').document;
		workspaceService.textDocuments.push(doc);
		if (uri.scheme !== Schemas.untitled) {
			fileSystem.mockFile(uri, text);
		}
	}
});

/**
 * As we want test to run on all platforms, we need to fix file paths in attachments
 * to use forward slashes for comparison.
 */
function fixFilePathsForTestComparison(attachments: Attachment[]): Attachment[] {
	attachments.forEach(attachment => {
		if (attachment.type === 'file') {
			attachment.path = attachment.path.replace(/\\/g, '/');
		} else if (attachment.type === 'directory') {
			attachment.path = attachment.path.replace(/\\/g, '/');
		}
	});
	return attachments;
}