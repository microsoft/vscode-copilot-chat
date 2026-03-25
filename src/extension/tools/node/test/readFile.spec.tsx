/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import { IChatDebugFileLoggerService } from '../../../../platform/chat/common/chatDebugFileLoggerService';
import { ICustomInstructionsService } from '../../../../platform/customInstructions/common/customInstructionsService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { MockCustomInstructionsService } from '../../../../platform/test/common/testCustomInstructionsService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { dirname } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { MarkdownString } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { IReadFileParamsV1, IReadFileParamsV2, ReadFileTool } from '../readFileTool';
import { toolResultToString } from './toolTestUtils';

suite('ReadFile', () => {
	let accessor: ITestingServicesAccessor;

	beforeAll(() => {
		const testDoc = createTextDocumentData(URI.file('/workspace/file.ts'), 'line 1\nline 2\n\nline 4\nline 5', 'ts').document;
		const emptyDoc = createTextDocumentData(URI.file('/workspace/empty.ts'), '', 'ts').document;
		const whitespaceDoc = createTextDocumentData(URI.file('/workspace/whitespace.ts'), ' \t\n', 'ts').document;
		const singleLineDoc = createTextDocumentData(URI.file('/workspace/single.ts'), 'single line', 'ts').document;
		// Create a large document for testing truncation (3000 lines to exceed MAX_LINES_PER_READ)
		const largeContent = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
		const largeDoc = createTextDocumentData(URI.file('/workspace/large.ts'), largeContent, 'ts').document;

		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[
				[URI.file('/workspace')],
				[testDoc, emptyDoc, whitespaceDoc, singleLineDoc, largeDoc],
			]
		));
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('read simple file', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IReadFileParamsV1 = {
			filePath: '/workspace/file.ts',
			startLine: 2,
			endLine: 6
		};
		const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
		expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`
			"line 2

			line 4
			line 5"
		`);
	});

	test('read empty file', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IReadFileParamsV1 = {
			filePath: '/workspace/empty.ts',
			startLine: 2,
			endLine: 6
		};
		const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
		expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`"(The file \`/workspace/empty.ts\` exists, but is empty)"`);
	});

	test('read whitespace file', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IReadFileParamsV1 = {
			filePath: '/workspace/whitespace.ts',
			startLine: 2,
			endLine: 6
		};
		const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
		expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`"(The file \`/workspace/whitespace.ts\` exists, but contains only whitespace)"`);
	});

	suite('IReadFileParamsV2', () => {
		test('read simple file with offset and limit', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 2,
				limit: 4
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`
				"line 2

				line 4
				line 5"
			`);
		});

		test('read simple file with only offset', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 3
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`
				"
				line 4
				line 5"
			`);
		});

		test('read simple file without offset or limit', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts'
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`
				"line 1
				line 2

				line 4
				line 5"
			`);
		});

		test('read empty file', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/empty.ts',
				offset: 1,
				limit: 4
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`"(The file \`/workspace/empty.ts\` exists, but is empty)"`);
		});

		test('read whitespace file', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/whitespace.ts',
				offset: 1,
				limit: 2
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			expect(await toolResultToString(accessor, result)).toMatchInlineSnapshot(`"(The file \`/workspace/whitespace.ts\` exists, but contains only whitespace)"`);
		});

		test('read file with limit larger than MAX_LINES_PER_READ should truncate', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/large.ts',
				offset: 1,
				limit: 3000 // This exceeds MAX_LINES_PER_READ (2000)
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			// Should be truncated to MAX_LINES_PER_READ (2000) and show truncation message
			const resultString = await toolResultToString(accessor, result);
			expect(resultString).toContain('line 1');
			expect(resultString).toContain('line 2000');
			expect(resultString).toContain('[File content truncated at line 2000. Use read_file with offset/limit parameters to view more.]');
			expect(resultString).not.toContain('line 2001');
		});

		test('read file with offset beyond file line count should throw error', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 535 // file only has 5 lines
			};
			await expect(toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None))
				.rejects.toThrow('Invalid offset 535: file only has 5 lines. Line numbers are 1-indexed.');
		});

		test('read file with offset beyond single-line file should throw error', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/whitespace.ts', // 2 line file (has a newline)
				offset: 10
			};
			await expect(toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None))
				.rejects.toThrow('Invalid offset 10: file only has 2 lines. Line numbers are 1-indexed.');
		});

		test('read file with offset exactly at line count should succeed', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 5, // file has exactly 5 lines
				limit: 1
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			const resultString = await toolResultToString(accessor, result);
			expect(resultString).toContain('line 5');
		});

		test('read empty file with offset beyond bounds should throw error', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/empty.ts',
				offset: 2
			};
			await expect(toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None))
				.rejects.toThrow('Invalid offset 2: file only has 1 line. Line numbers are 1-indexed.');
		});

		test('read file with offset 0 should clamp to line 1', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 0,
				limit: 2
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			const resultString = await toolResultToString(accessor, result);
			// Should start from line 1 (offset clamped to 1)
			expect(resultString).toContain('line 1');
			expect(resultString).toContain('line 2');
		});

		test('read single-line file with offset beyond bounds should throw error with singular "line"', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/single.ts',
				offset: 2
			};
			await expect(toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None))
				.rejects.toThrow('Invalid offset 2: file only has 1 line. Line numbers are 1-indexed.');
		});

		test('read file with limit of 1', async () => {
			const toolsService = accessor.get(IToolsService);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/file.ts',
				offset: 2,
				limit: 1
			};
			const result = await toolsService.invokeTool(ToolName.ReadFile, { input, toolInvocationToken: null as never }, CancellationToken.None);
			const resultString = await toolResultToString(accessor, result);
			expect(resultString).toContain('line 2');
			expect(resultString).not.toContain('line 3');
		});
	});

	suite('prepareInvocation', () => {
		test('should return "Reading/Read skill" message for skill files', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.skill.md'), 'skill content', 'markdown').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			mockCustomInstructions.setSkillFiles([URI.file('/workspace/test.skill.md')]);
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.skill.md'
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			expect((result!.invocationMessage as MarkdownString).value).toBe('Reading skill [workspace](file:///workspace/test.skill.md?vscodeLinkType%3Dskill)');
			expect((result!.pastTenseMessage as MarkdownString).value).toBe('Read skill [workspace](file:///workspace/test.skill.md?vscodeLinkType%3Dskill)');

			testAccessor.dispose();
		});

		test('should return "Reading/Read" message for non-skill files', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.ts'), 'code content', 'typescript').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			// Don't mark this file as a skill file
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.ts'
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			expect((result!.invocationMessage as MarkdownString).value).toBe('Reading [](file:///workspace/test.ts)');
			expect((result!.pastTenseMessage as MarkdownString).value).toBe('Read [](file:///workspace/test.ts)');

			testAccessor.dispose();
		});

		test('should return "Reading skill/Read skill" message for skill files with line range', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.skill.md'), 'line 1\nline 2\nline 3\nline 4\nline 5', 'markdown').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			mockCustomInstructions.setSkillFiles([URI.file('/workspace/test.skill.md')]);
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.skill.md',
				offset: 2,
				limit: 2
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			// When reading a partial range of a skill file, it should say "Reading skill"
			expect((result!.invocationMessage as MarkdownString).value).toBe('Reading skill [workspace](file:///workspace/test.skill.md?vscodeLinkType%3Dskill#2-2), lines 2 to 4');
			expect((result!.pastTenseMessage as MarkdownString).value).toBe('Read skill [workspace](file:///workspace/test.skill.md?vscodeLinkType%3Dskill#2-2), lines 2 to 4');

			testAccessor.dispose();
		});

		test('should return "Reading/Read skill" message for non-.md skill files', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.skill'), 'skill content', 'plaintext').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			mockCustomInstructions.setSkillFiles([URI.file('/workspace/test.skill')]);
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.skill'
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			// For non-.md skill files, skill name should be in backticks
			expect((result!.invocationMessage as MarkdownString).value).toContain('Reading skill `workspace`: [](file:///workspace/test.skill)');
			expect((result!.pastTenseMessage as MarkdownString).value).toContain('Read skill `workspace`: [](file:///workspace/test.skill)');

			testAccessor.dispose();
		});

		test('should return "Reading/Read skill" message for non-.md skill files with line range', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.skill'), 'line 1\nline 2\nline 3\nline 4\nline 5', 'plaintext').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			mockCustomInstructions.setSkillFiles([URI.file('/workspace/test.skill')]);
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.skill',
				offset: 2,
				limit: 2
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			// For non-.md skill files with range, skill name should be in backticks
			expect((result!.invocationMessage as MarkdownString).value).toContain('Reading skill `workspace`: [](file:///workspace/test.skill#2-2), lines 2 to 4');
			expect((result!.pastTenseMessage as MarkdownString).value).toContain('Read skill `workspace`: [](file:///workspace/test.skill#2-2), lines 2 to 4');

			testAccessor.dispose();
		});

		test('should return "Reading/Read" message for non-skill files with line range', async () => {
			const testDoc = createTextDocumentData(URI.file('/workspace/test.ts'), 'line 1\nline 2\nline 3\nline 4\nline 5', 'typescript').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[
					[URI.file('/workspace')],
					[testDoc],
				]
			));

			const mockCustomInstructions = new MockCustomInstructionsService();
			// Don't mark this file as a skill file
			services.define(ICustomInstructionsService, mockCustomInstructions);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = {
				filePath: '/workspace/test.ts',
				offset: 2,
				limit: 2
			};

			const result = await readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			);

			expect(result).toBeDefined();
			// When reading a partial range of a non-skill file, it should say "Reading"
			expect((result!.invocationMessage as MarkdownString).value).toBe('Reading [](file:///workspace/test.ts#2-2), lines 2 to 4');
			expect((result!.pastTenseMessage as MarkdownString).value).toBe('Read [](file:///workspace/test.ts#2-2), lines 2 to 4');

			testAccessor.dispose();
		});
	});

	suite('image files', () => {
		test('throws for image files and points to view_image', async () => {
			const services = createExtensionUnitTestingServices();
			const mockFs = new MockFileSystemService();
			mockFs.mockFile(URI.file('/workspace/photo.jpg'), 'fake-image-bytes');
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/photo.jpg' };
			await expect(readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			)).rejects.toThrow('Use view_image instead');

			testAccessor.dispose();
		});

		test('prepareInvocation throws for image files and points to view_image', async () => {
			const services = createExtensionUnitTestingServices();
			const mockFs = new MockFileSystemService();
			mockFs.mockFile(URI.file('/workspace/photo.png'), 'fake-image-bytes');
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/photo.png' };
			await expect(readFileTool.prepareInvocation(
				{ input },
				CancellationToken.None
			)).rejects.toThrow('Use view_image instead');

			testAccessor.dispose();
		});
	});

	suite('binary files', () => {
		function createBinaryMockFs(uri: URI, data: Uint8Array): MockFileSystemService {
			return new class extends MockFileSystemService {
				override async readFile(resource: URI): Promise<Uint8Array> {
					if (resource.toString() === uri.toString()) {
						return data;
					}
					return super.readFile(resource);
				}
			}();
		}

		test('returns hexdump for binary file', async () => {
			const binaryUri = URI.file('/workspace/binary.dat');
			// Data with null bytes triggers binary detection
			const binaryData = new Uint8Array([0x4d, 0x5a, 0x00, 0x03, 0x00, 0x00, 0xff, 0xfe]);
			const mockFs = createBinaryMockFs(binaryUri, binaryData);

			const services = createExtensionUnitTestingServices();
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/binary.dat' };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			// Should contain hex representation
			expect(text).toContain('4d 5a 00 03');
			expect(text).toContain('MZ');

			testAccessor.dispose();
		});

		test('returns hexdump with v1 byte range params', async () => {
			const binaryUri = URI.file('/workspace/binary.dat');
			const binaryData = new Uint8Array(64);
			for (let i = 0; i < 64; i++) {
				binaryData[i] = i;
			}
			// Ensure there's a null byte for detection
			binaryData[0] = 0x00;
			const mockFs = createBinaryMockFs(binaryUri, binaryData);

			const services = createExtensionUnitTestingServices();
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV1 = { filePath: '/workspace/binary.dat', startLine: 16, endLine: 32 };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			// Should contain hex starting from offset 16
			expect(text).toContain('00000010');

			testAccessor.dispose();
		});

		test('returns hexdump with v2 offset/limit byte params', async () => {
			const binaryUri = URI.file('/workspace/binary.dat');
			const binaryData = new Uint8Array(64);
			for (let i = 0; i < 64; i++) {
				binaryData[i] = i;
			}
			binaryData[0] = 0x00;
			const mockFs = createBinaryMockFs(binaryUri, binaryData);

			const services = createExtensionUnitTestingServices();
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/binary.dat', offset: 16 };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			// Should contain hex starting from byte offset 16
			expect(text).toContain('00000010');

			testAccessor.dispose();
		});

		test('returns hexdump with v2 offset and limit byte params', async () => {
			const binaryUri = URI.file('/workspace/binary.dat');
			const binaryData = new Uint8Array(128);
			for (let i = 0; i < 128; i++) {
				binaryData[i] = i;
			}
			binaryData[0] = 0x00;
			const mockFs = createBinaryMockFs(binaryUri, binaryData);

			const services = createExtensionUnitTestingServices();
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], []]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/binary.dat', offset: 16, limit: 16 };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			// Should contain hex starting from byte offset 16
			expect(text).toContain('00000010');
			// Should NOT contain hex from byte offset 32 (limit=16 means only 16 bytes)
			expect(text).not.toContain('00000020');

			testAccessor.dispose();
		});

		test('does not treat text files as binary', async () => {
			const textUri = URI.file('/workspace/text.dat');
			// Pure text content with no null bytes
			const textData = new TextEncoder().encode('Hello, world!\nThis is text.\n');
			const mockFs = createBinaryMockFs(textUri, textData);

			// Also register as a text document so openTextDocument works
			const textDoc = createTextDocumentData(textUri, 'Hello, world!\nThis is text.\n', 'plaintext').document;
			const services = createExtensionUnitTestingServices();
			services.define(IFileSystemService, mockFs);
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], [textDoc]]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: '/workspace/text.dat' };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			// Should contain the original text, not hex
			expect(text).toContain('Hello, world!');
			expect(text).not.toContain('00000000');

			testAccessor.dispose();
		});
	});

	suite('troubleshoot skill session log replacement', () => {
		test('replaces {{CURRENT_SESSION_LOG}} placeholder for troubleshoot skill URI', async () => {
			const skillUri = URI.from({ scheme: 'copilot-skill', path: '/troubleshoot/SKILL.md' });
			const skillContent = '---\nname: troubleshoot\n---\n\nLog dir: `{{CURRENT_SESSION_LOG}}`\nMore content here.';
			const skillDoc = createTextDocumentData(skillUri, skillContent, 'markdown').document;

			const expectedLogDir = URI.file('/mock/storage/debug-logs/session-abc');

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], [skillDoc]]
			));
			services.define(IChatDebugFileLoggerService, {
				_serviceBrand: undefined,
				startSession: async () => { },
				endSession: async () => { },
				flush: async () => { },
				getLogPath: () => undefined,
				getSessionDir: () => undefined,
				getActiveSessionIds: () => [],
				isDebugLogUri: () => false,
				getSessionDirForResource: () => expectedLogDir,
				debugLogsDir: dirname(expectedLogDir),
				listSessionDirsOnDisk: async () => [],
				setPendingTroubleshootTarget: () => { },
				hasPendingTroubleshootTarget: () => false,
				consumePendingTroubleshootTarget: () => undefined,
				registerTroubleshootTarget: () => { },
				getTroubleshootTarget: () => undefined,
			} satisfies IChatDebugFileLoggerService);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);
			const promptPathRepresentationService = testAccessor.get(IPromptPathRepresentationService);

			// Set up prompt context with a sessionResource
			await readFileTool.resolveInput(
				{ filePath: skillUri.toString(), startLine: 1, endLine: 100 },
				{ query: '', history: [], chatVariables: { *[Symbol.iterator]() { } } as never, request: { sessionResource: URI.parse('vscode-chat-session://local/c2Vzc2lvbi1hYmM=') } } as never,
			);

			const input: IReadFileParamsV2 = { filePath: skillUri.toString() };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			expect(text).toContain(promptPathRepresentationService.getFilePath(expectedLogDir));
			expect(text).not.toContain('{{CURRENT_SESSION_LOG}}');

			testAccessor.dispose();
		});

		test('leaves placeholder unreplaced when no sessionResource is set', async () => {
			const skillUri = URI.from({ scheme: 'copilot-skill', path: '/troubleshoot/SKILL.md' });
			const skillContent = '---\nname: troubleshoot\n---\n\nLog dir: `{{CURRENT_SESSION_LOG}}`';
			const skillDoc = createTextDocumentData(skillUri, skillContent, 'markdown').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], [skillDoc]]
			));

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			const input: IReadFileParamsV2 = { filePath: skillUri.toString() };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			expect(text).toContain('{{CURRENT_SESSION_LOG}}');

			testAccessor.dispose();
		});

		test('does not replace placeholder for non-troubleshoot skill URIs', async () => {
			const otherSkillUri = URI.from({ scheme: 'copilot-skill', path: '/other-skill/SKILL.md' });
			const content = 'Some content with {{CURRENT_SESSION_LOG}} placeholder';
			const doc = createTextDocumentData(otherSkillUri, content, 'markdown').document;

			const services = createExtensionUnitTestingServices();
			services.define(IWorkspaceService, new SyncDescriptor(
				TestWorkspaceService,
				[[URI.file('/workspace')], [doc]]
			));
			services.define(IChatDebugFileLoggerService, {
				_serviceBrand: undefined,
				startSession: async () => { },
				endSession: async () => { },
				flush: async () => { },
				getLogPath: () => undefined,
				getSessionDir: () => undefined,
				getActiveSessionIds: () => [],
				isDebugLogUri: () => false,
				getSessionDirForResource: () => URI.file('/should/not/appear'),
				debugLogsDir: URI.file('/should/not/appear'),
				listSessionDirsOnDisk: async () => [],
				setPendingTroubleshootTarget: () => { },
				hasPendingTroubleshootTarget: () => false,
				consumePendingTroubleshootTarget: () => undefined,
				registerTroubleshootTarget: () => { },
				getTroubleshootTarget: () => undefined,
			} satisfies IChatDebugFileLoggerService);

			const testAccessor = services.createTestingAccessor();
			const readFileTool = testAccessor.get(IInstantiationService).createInstance(ReadFileTool);

			await readFileTool.resolveInput(
				{ filePath: otherSkillUri.toString(), startLine: 1, endLine: 100 },
				{ query: '', history: [], chatVariables: { *[Symbol.iterator]() { } } as never, request: { sessionResource: URI.parse('vscode-chat-session://local/c2Vzc2lvbi1hYmM=') } } as never,
			);

			const input: IReadFileParamsV2 = { filePath: otherSkillUri.toString() };
			const result = await readFileTool.invoke(
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			);

			const text = await toolResultToString(testAccessor, result);
			expect(text).toContain('{{CURRENT_SESSION_LOG}}');
			expect(text).not.toContain('/should/not/appear');

			testAccessor.dispose();
		});
	});
});
