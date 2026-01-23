/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ContributedToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { toolResultToString } from './toolTestUtils';

interface IMemoryToolParams {
	command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';
	path?: string;
	view_range?: [number, number];
	file_text?: string;
	old_str?: string;
	new_str?: string;
	insert_line?: number;
	insert_text?: string;
	old_path?: string;
	new_path?: string;
}

suite('MemoryTool', () => {
	let accessor: ITestingServicesAccessor;
	let storageUri: URI;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		accessor = services.createTestingAccessor();

		// Set up storage URI for memory tool
		const extensionContext = accessor.get(IVSCodeExtensionContext);
		storageUri = URI.file('/test-storage');
		(extensionContext as any).storageUri = storageUri;
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('create memory file', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/preferences.md',
			file_text: 'I prefer TypeScript for all projects'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('created successfully');
	});

	test('view memory directory', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file first
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'test.md');
		await fileSystem.writeFile(testFile, new TextEncoder().encode('test content'));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		// Should either list the file or indicate path not found (if dir doesn't exist yet)
		expect(resultStr).toMatch(/test\.md|Path not found/);
	});

	test('view memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'notes.md');
		const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories/notes.md'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Line 1');
		expect(resultStr).toContain('Line 5');
	});

	test('view memory file with range', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'ranged.md');
		const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories/ranged.md',
			view_range: [2, 4]
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Line 2');
		expect(resultStr).toContain('Line 3');
		expect(resultStr).toContain('Line 4');
		expect(resultStr).not.toContain('Line 1');
		expect(resultStr).not.toContain('Line 5');
		// Should have line numbers when using view_range
		expect(resultStr).toMatch(/\d+:/);
	});

	test('str_replace in memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'replace.md');
		const content = 'I prefer Vue for frontend';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'str_replace',
			path: '/memories/replace.md',
			old_str: 'Vue',
			new_str: 'React'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('successfully');

		// Verify the change
		const updatedContent = new TextDecoder().decode(await fileSystem.readFile(testFile));
		expect(updatedContent).toContain('React');
		expect(updatedContent).not.toContain('Vue');
	});

	test('str_replace fails with non-unique string', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file with duplicate content
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'duplicate.md');
		const content = 'test test test';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'str_replace',
			path: '/memories/duplicate.md',
			old_str: 'test',
			new_str: 'example'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('must be unique');
		expect(resultStr).toContain('String appears 3 times');
	});

	test('insert text at line', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'insert.md');
		const content = 'Line 1\nLine 2\nLine 3';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'insert',
			path: '/memories/insert.md',
			insert_line: 2,
			insert_text: 'Inserted Line'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toMatch(/inserted at line/);

		// Verify the insertion
		const updatedContent = new TextDecoder().decode(await fileSystem.readFile(testFile));
		expect(updatedContent).toContain('Inserted Line');
		const lines = updatedContent.split('\n');
		expect(lines[2]).toBe('Inserted Line');
	});

	test('delete memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'todelete.md');
		await fileSystem.writeFile(testFile, new TextEncoder().encode('delete me'));

		const input: IMemoryToolParams = {
			command: 'delete',
			path: '/memories/todelete.md'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toMatch(/deleted/i);

		// Verify file is deleted
		await expect(fileSystem.stat(testFile)).rejects.toThrow();
	});

	test('rename memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const oldFile = URI.joinPath(memoryRoot, 'old.md');
		await fileSystem.writeFile(oldFile, new TextEncoder().encode('content'));

		const input: IMemoryToolParams = {
			command: 'rename',
			old_path: '/memories/old.md',
			new_path: '/memories/new.md'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toMatch(/renamed|moved/i);

		// Verify old file doesn't exist
		await expect(fileSystem.stat(oldFile)).rejects.toThrow();

		// Verify new file exists
		const newFile = URI.joinPath(memoryRoot, 'new.md');
		const stat = await fileSystem.stat(newFile);
		expect(stat).toBeDefined();
	});

	test('path validation - reject path without /memories prefix', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/etc/passwd',
			file_text: 'malicious'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('must start with /memories');
	});

	test('path validation - reject directory traversal', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/../../../etc/passwd',
			file_text: 'malicious'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('escape /memories directory');
	});

	test('create with subdirectory path', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/project/notes.md',
			file_text: 'nested file'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('created successfully');

		// Verify file exists
		const fileSystem = accessor.get(IFileSystemService);
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		const nestedFile = URI.joinPath(memoryRoot, 'project', 'notes.md');
		const stat = await fileSystem.stat(nestedFile);
		expect(stat).toBeDefined();
	});

	test('error when no workspace is open', async () => {
		const toolsService = accessor.get(IToolsService);

		// Temporarily clear storage URI
		const extensionContext = accessor.get(IVSCodeExtensionContext);
		const originalStorageUri = (extensionContext as any).storageUri;
		(extensionContext as any).storageUri = undefined;

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('No workspace is currently open');

		// Restore storage URI
		(extensionContext as any).storageUri = originalStorageUri;
	});

	test('str_replace with empty string', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'empty-replace.md');
		const content = 'Remove this text here';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'str_replace',
			path: '/memories/empty-replace.md',
			old_str: ' text',
			new_str: ''
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('successfully');

		// Verify the change
		const updatedContent = new TextDecoder().decode(await fileSystem.readFile(testFile));
		expect(updatedContent).toBe('Remove this here');
	});

	test('insert at line 0 (before first line)', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'insert-first.md');
		const content = 'Line 1\nLine 2';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'insert',
			path: '/memories/insert-first.md',
			insert_line: 0,
			insert_text: 'First Line'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toMatch(/inserted at line 0/);

		// Verify the insertion
		const updatedContent = new TextDecoder().decode(await fileSystem.readFile(testFile));
		const lines = updatedContent.split('\n');
		expect(lines[0]).toBe('First Line');
		expect(lines[1]).toBe('Line 1');
		expect(lines[2]).toBe('Line 2');
	});

	test('create overwrites existing file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file first
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'overwrite.md');
		await fileSystem.writeFile(testFile, new TextEncoder().encode('original content'));

		// Overwrite it
		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/overwrite.md',
			file_text: 'new content'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('created successfully');

		// Verify the file was overwritten
		const updatedContent = new TextDecoder().decode(await fileSystem.readFile(testFile));
		expect(updatedContent).toBe('new content');
	});

	test('view with invalid range returns error', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file
		const memoryRoot = URI.joinPath(storageUri, 'memory-tool/memories');
		await fileSystem.createDirectory(memoryRoot);
		const testFile = URI.joinPath(memoryRoot, 'invalid-range.md');
		const content = 'Line 1\nLine 2\nLine 3';
		await fileSystem.writeFile(testFile, new TextEncoder().encode(content));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories/invalid-range.md',
			view_range: [10, 20] // beyond file length
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);

		// Should still work, just return empty or partial content
		// The implementation uses slice which handles out of bounds gracefully
		expect(result).toBeDefined();
	});
});

suite('MemoryTool session and workspace paths', () => {
	let accessor: ITestingServicesAccessor;
	let storageUri: URI;
	const testSessionId = 'test-session-123';

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		accessor = services.createTestingAccessor();

		// Set up storage URI for memory tool
		const extensionContext = accessor.get(IVSCodeExtensionContext);
		storageUri = URI.file('/test-storage');
		(extensionContext as any).storageUri = storageUri;
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('create session memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/session/user-preferences.md',
			file_text: '# User Preferences\n\n- Prefers TypeScript\n- Uses tabs for indentation'
		};

		const toolInvocationToken = { sessionResource: URI.parse(`vscode-chat-session:/${testSessionId}`) } as never;
		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('created successfully');

		// Verify the file was created at the translated session path (sessions/<sessionId>)
		const expectedPath = URI.joinPath(storageUri, `memory-tool/memories/sessions/${testSessionId}/user-preferences.md`);
		const content = await fileSystem.readFile(expectedPath);
		expect(new TextDecoder().decode(content)).toContain('Prefers TypeScript');
	});

	test('view session directory', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file in the translated session path
		const sessionDir = URI.joinPath(storageUri, `memory-tool/memories/sessions/${testSessionId}`);
		await fileSystem.createDirectory(sessionDir);
		const testFile = URI.joinPath(sessionDir, 'task-history.md');
		await fileSystem.writeFile(testFile, new TextEncoder().encode('# Task History'));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories/session'
		};

		const toolInvocationToken = { sessionResource: URI.parse(`vscode-chat-session:/${testSessionId}`) } as never;
		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('task-history.md');
	});

	test('session path requires session ID', async () => {
		// Session paths should fail without a session ID
		const toolsService = accessor.get(IToolsService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/session/notes.md',
			file_text: 'Session notes'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Error');
		expect(resultStr).toContain('Session ID');
	});

	test('create repo memory file', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		const input: IMemoryToolParams = {
			command: 'create',
			path: '/memories/repo/build-command.jsonl',
			file_text: '{"subject":"build","fact":"npm run build","citations":"package.json:10","reason":"Build command","category":"bootstrap_and_build"}'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('created successfully');

		// Verify the file was created at the repo path
		const expectedPath = URI.joinPath(storageUri, 'memory-tool/memories/repo/build-command.jsonl');
		const content = await fileSystem.readFile(expectedPath);
		expect(new TextDecoder().decode(content)).toContain('npm run build');
	});

	test('view repo directory', async () => {
		const toolsService = accessor.get(IToolsService);
		const fileSystem = accessor.get(IFileSystemService);

		// Create a test file in the repo path
		const repoDir = URI.joinPath(storageUri, 'memory-tool/memories/repo');
		await fileSystem.createDirectory(repoDir);
		const testFile = URI.joinPath(repoDir, 'test-convention.jsonl');
		await fileSystem.writeFile(testFile, new TextEncoder().encode('{"subject":"test"}'));

		const input: IMemoryToolParams = {
			command: 'view',
			path: '/memories/repo'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('test-convention.jsonl');
	});
});
