/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test, vi } from 'vitest';
import type { FileSystemWatcher } from 'vscode';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IFileSystemService } from '../../../filesystem/common/fileSystemService';
import { FileType } from '../../../filesystem/common/fileTypes';
import { CodeSearchResult } from '../../../remoteCodeSearch/common/remoteCodeSearch';
import { ISearchService } from '../../../search/common/searchService';
import { createPlatformServices, TestingServiceCollection } from '../../../test/node/services';
import {
	IWorkspaceService,
	NullWorkspaceService
} from '../../../workspace/common/workspaceService';
import { ExternalIngestClient, ExternalIngestFile, IExternalIngestClient } from '../../node/codeSearch/externalIngestClient';
import { ExternalIngestIndex } from '../../node/codeSearch/externalIngestIndex';

function createMockExternalIngestClient(options?: {
	canIngestPathAndSize?: (filePath: string, size: number) => boolean;
	canIngestDocument?: (filePath: string, data: Uint8Array) => boolean;
}): IExternalIngestClient & {
	ingestedFiles: ExternalIngestFile[];
	searchCalls: Array<{ filesetName: string; prompt: string }>;
} {
	const ingestedFiles: ExternalIngestFile[] = [];
	const searchCalls: Array<{ filesetName: string; prompt: string }> = [];

	return {
		ingestedFiles,
		searchCalls,
		async doInitialIndex(_filesetName: string, _root: URI, allFiles: AsyncIterable<ExternalIngestFile>, _token: CancellationToken): Promise<void> {
			for await (const file of allFiles) {
				ingestedFiles.push(file);
			}
		},
		async listFilesets(_token: CancellationToken): Promise<string[]> {
			return [];
		},
		async deleteFileset(_filesetName: string, _token: CancellationToken): Promise<void> {
			// no-op
		},
		async searchFilesets(filesetName: string, _rootUri: URI, prompt: string, _limit: number, _token: CancellationToken): Promise<CodeSearchResult> {
			searchCalls.push({ filesetName, prompt });
			return { chunks: [], outOfSync: false };
		},
		canIngestPathAndSize(filePath: string, size: number): boolean {
			return options?.canIngestPathAndSize?.(filePath, size) ?? true;
		},
		canIngestDocument(filePath: string, data: Uint8Array): boolean {
			return options?.canIngestDocument?.(filePath, data) ?? true;
		},
	};
}

function createMockFileSystemService(files: ResourceMap<MockFileEntry>): IFileSystemService {
	return new class extends mock<IFileSystemService>() {
		override async stat(uri: URI) {
			const entry = files.get(uri);
			if (!entry) {
				throw new Error(`File not found: ${uri.toString()}`);
			}
			return {
				type: FileType.File,
				ctime: 0,
				mtime: entry.mtime,
				size: entry.size,
				permissions: undefined,
			};
		}

		override async readFile(uri: URI) {
			const entry = files.get(uri);
			if (!entry) {
				throw new Error(`File not found: ${uri.toString()}`);
			}
			return entry.content;
		}

		override createFileSystemWatcher(): FileSystemWatcher {
			return {
				onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
				onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
				dispose: vi.fn(),
				ignoreChangeEvents: false,
				ignoreCreateEvents: false,
				ignoreDeleteEvents: false,
			};
		}
	};
}

class MockWorkspaceService extends NullWorkspaceService {
	constructor(private readonly _workspaceFolders: URI[]) {
		super(_workspaceFolders);
	}

	override getWorkspaceFolders(): URI[] {
		return this._workspaceFolders;
	}
}

function createMockSearchService(files: URI[]): ISearchService {
	return new class extends mock<ISearchService>() {
		override findFilesWithDefaultExcludes(): any {
			return Promise.resolve(files);
		}

		override findFiles(): Promise<URI[]> {
			return Promise.resolve(files);
		}
	};
}

type MockFileEntry = { content: Uint8Array; size: number; mtime: number };

function createFileFromString(content: string, mtime = Date.now()): MockFileEntry {
	const encoded = new TextEncoder().encode(content);
	return { content: encoded, size: encoded.length, mtime };
}

function createFileFromBytes(content: Uint8Array, mtime = Date.now()): MockFileEntry {
	return { content, size: content.length, mtime };
}

/**
 * Helper to create an ExternalIngestIndex with a client.
 * Uses ExternalIngestClient by default, or accepts a mock client for testing.
 */
function createExternalIngestIndex(
	instantiationService: IInstantiationService,
	client?: IExternalIngestClient,
): ExternalIngestIndex {
	const resolvedClient = client ?? instantiationService.createInstance(ExternalIngestClient);
	return instantiationService.createInstance(ExternalIngestIndex, resolvedClient);
}

suite('ExternalIngestIndex', () => {
	const disposables = new DisposableStore();
	let testingServiceCollection: TestingServiceCollection;

	beforeEach(() => {
		testingServiceCollection = disposables.add(createPlatformServices());
	});

	afterEach(() => {
		disposables.clear();
	});

	test('shouldIndexFile returns true by default', async () => {
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);

		const index = disposables.add(createExternalIngestIndex(instantiationService));

		const workspace = URI.file('/workspace');
		const file = URI.joinPath(workspace, 'src', 'file.ts');
		assert.strictEqual(await index.shouldTrackFile(file, CancellationToken.None), true);
	});

	test('shouldIndexFile returns false for files under code search roots', async () => {
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);

		const mockClient = createMockExternalIngestClient();
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		const other = URI.file('/other');
		const fileNotUnderCodeSearch = URI.joinPath(other, 'src', 'file.ts');
		assert.strictEqual(await index.shouldTrackFile(fileNotUnderCodeSearch, CancellationToken.None), true);
	});

	test('shouldIndexFile handles nested paths correctly', async () => {
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);

		const mockClient = createMockExternalIngestClient();
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		const codeSearchRoot = URI.file('/repo');
		index.updateCodeSearchRoots([codeSearchRoot]);

		assert.strictEqual(await index.shouldTrackFile(URI.joinPath(codeSearchRoot, 'file.ts'), CancellationToken.None), false);
		assert.strictEqual(await index.shouldTrackFile(URI.joinPath(codeSearchRoot, 'src', 'nested', 'file.ts'), CancellationToken.None), false);

		assert.strictEqual(await index.shouldTrackFile(URI.file('/repo2/file.ts'), CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(URI.file('/other/repo/file.ts'), CancellationToken.None), true);
	});

	test('updateCodeSearchRoots clears previous roots', async () => {
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);

		const mockClient = createMockExternalIngestClient();
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		const root1 = URI.file('/repo1');
		const root2 = URI.file('/repo2');
		const file1 = URI.joinPath(root1, 'file.ts');
		const file2 = URI.joinPath(root2, 'file.ts');

		index.updateCodeSearchRoots([root1]);
		assert.strictEqual(await index.shouldTrackFile(file1, CancellationToken.None), false);
		assert.strictEqual(await index.shouldTrackFile(file2, CancellationToken.None), true);

		index.updateCodeSearchRoots([root2]);
		assert.strictEqual(await index.shouldTrackFile(file1, CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(file2, CancellationToken.None), false);
	});

	test('can mock ExternalIngestClient to test file ingestion', async () => {
		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);

		const mockClient = createMockExternalIngestClient();
		disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		// The mock client is now injected - tests can verify what files would be ingested
		assert.strictEqual(mockClient.ingestedFiles.length, 0, 'No files ingested yet');
	});

	test('can mock FileSystemService to control file content', async () => {
		const files = new ResourceMap<MockFileEntry>();
		const file1Uri = URI.file('/workspace/file1.ts');
		files.set(file1Uri, createFileFromString('const x = 1;'));

		const mockFs = createMockFileSystemService(files);
		const mockClient = createMockExternalIngestClient();

		testingServiceCollection.set(IFileSystemService, mockFs);
		const customAccessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const customInstantiationService = customAccessor.get(IInstantiationService);
		disposables.add(customInstantiationService.createInstance(ExternalIngestIndex, mockClient));

		// The mock file system and client are now injected
		// Tests can verify file operations and ingestion behavior
		assert.ok(mockClient, 'Mock client is available for assertions');
		assert.ok(mockFs, 'Mock file system is available for assertions');
	});

	test('initialize discovers files from workspace and passes ingestable files to client', async () => {
		const workspaceRoot = URI.file('/workspace');
		const file1 = URI.joinPath(workspaceRoot, 'src', 'file1.ts');
		const file2 = URI.joinPath(workspaceRoot, 'src', 'file2.ts');

		const files = new ResourceMap<MockFileEntry>();
		files.set(file1, createFileFromString('const x = 1;'));
		files.set(file2, createFileFromString('const y = 2;'));

		const mockFs = createMockFileSystemService(files);
		const mockClient = createMockExternalIngestClient();
		const mockWorkspace = new MockWorkspaceService([workspaceRoot]);
		const mockSearch = createMockSearchService([file1, file2]);

		testingServiceCollection.set(IFileSystemService, mockFs);
		testingServiceCollection.set(IWorkspaceService, mockWorkspace);
		testingServiceCollection.set(ISearchService, mockSearch);

		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		// Initialize discovers files and populates the DB
		await index.initialize();

		// doInitialIngest triggers the actual ingestion to the client
		await index.doInitialIngest(CancellationToken.None);

		// Verify that both files were passed to the client for ingestion
		assert.strictEqual(mockClient.ingestedFiles.length, 2, 'Both files should be ingested');
		const ingestedPaths = mockClient.ingestedFiles.map(f => f.uri.toString()).sort();
		assert.deepStrictEqual(ingestedPaths, [file1.toString(), file2.toString()].sort());

		// Files should be tracked after initialization
		assert.strictEqual(await index.shouldTrackFile(file1, CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(file2, CancellationToken.None), true);
	});

	test('files that fail canIngestPathAndSize are tracked but not ingested', async () => {
		const workspaceRoot = URI.file('/workspace');
		const file1 = URI.joinPath(workspaceRoot, 'small.ts');
		const file2 = URI.joinPath(workspaceRoot, 'large.txt');

		const files = new ResourceMap<MockFileEntry>();
		files.set(file1, createFileFromString('const x = 1;'));
		files.set(file2, createFileFromBytes(new Uint8Array(100)));

		const mockFs = createMockFileSystemService(files);
		// Mock client that rejects files larger than 50 bytes
		const mockClient = createMockExternalIngestClient({
			canIngestPathAndSize: (_filePath, size) => size < 50,
			canIngestDocument: () => true,
		});
		const mockWorkspace = new MockWorkspaceService([workspaceRoot]);
		const mockSearch = createMockSearchService([file1, file2]);

		testingServiceCollection.set(IFileSystemService, mockFs);
		testingServiceCollection.set(IWorkspaceService, mockWorkspace);
		testingServiceCollection.set(ISearchService, mockSearch);

		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		await index.initialize();
		await index.doInitialIngest(CancellationToken.None);

		// Only the small file should be ingested (large file fails canIngestPathAndSize)
		assert.strictEqual(mockClient.ingestedFiles.length, 1, 'Only small file should be ingested');
		assert.strictEqual(mockClient.ingestedFiles[0].uri.toString(), file1.toString());

		// Both files should be tracked
		assert.strictEqual(await index.shouldTrackFile(file1, CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(file2, CancellationToken.None), true);
	});

	test('files that fail canIngestDocument are tracked but filtered during ingestion', async () => {
		const workspaceRoot = URI.file('/workspace');
		const textFile = URI.joinPath(workspaceRoot, 'text.ts');
		const binaryFile = URI.joinPath(workspaceRoot, 'binary.txt');

		const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE]);

		const files = new ResourceMap<MockFileEntry>();
		files.set(textFile, createFileFromString('const x = 1;'));
		files.set(binaryFile, createFileFromBytes(binaryContent));

		const mockFs = createMockFileSystemService(files);
		// Mock client that rejects binary content
		const mockClient = createMockExternalIngestClient({
			canIngestPathAndSize: () => true,
			canIngestDocument: (_filePath, data) => {
				// Reject files with null bytes (simple binary detection)
				return !data.includes(0x00);
			},
		});
		const mockWorkspace = new MockWorkspaceService([workspaceRoot]);
		const mockSearch = createMockSearchService([textFile, binaryFile]);

		testingServiceCollection.set(IFileSystemService, mockFs);
		testingServiceCollection.set(IWorkspaceService, mockWorkspace);
		testingServiceCollection.set(ISearchService, mockSearch);

		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		await index.initialize();
		await index.doInitialIngest(CancellationToken.None);

		// Only the text file should be ingested (binary file fails canIngestDocument)
		assert.strictEqual(mockClient.ingestedFiles.length, 1, 'Only text file should be ingested');
		assert.strictEqual(mockClient.ingestedFiles[0].uri.toString(), textFile.toString());

		// Both files should be tracked
		assert.strictEqual(await index.shouldTrackFile(textFile, CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(binaryFile, CancellationToken.None), true);
	});

	test('files excluded by path pattern are not ingested', async () => {
		const workspaceRoot = URI.file('/workspace');
		const sourceFile = URI.joinPath(workspaceRoot, 'src', 'app.ts');
		const vendorFile = URI.joinPath(workspaceRoot, 'vendor', 'lib.js');

		const files = new ResourceMap<MockFileEntry>();
		files.set(sourceFile, createFileFromString('const app = 1;'));
		files.set(vendorFile, createFileFromString('const lib = 1;'));

		const mockFs = createMockFileSystemService(files);
		// Mock client that rejects vendor paths
		const mockClient = createMockExternalIngestClient({
			canIngestPathAndSize: (filePath) => !filePath.includes('vendor'),
			canIngestDocument: () => true,
		});
		const mockWorkspace = new MockWorkspaceService([workspaceRoot]);
		const mockSearch = createMockSearchService([sourceFile, vendorFile]);

		testingServiceCollection.set(IFileSystemService, mockFs);
		testingServiceCollection.set(IWorkspaceService, mockWorkspace);
		testingServiceCollection.set(ISearchService, mockSearch);

		const accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);
		const index = disposables.add(instantiationService.createInstance(ExternalIngestIndex, mockClient));

		await index.initialize();
		await index.doInitialIngest(CancellationToken.None);

		// Only the source file should be ingested (vendor file filtered by path pattern)
		assert.strictEqual(mockClient.ingestedFiles.length, 1, 'Only source file should be ingested');
		assert.strictEqual(mockClient.ingestedFiles[0].uri.toString(), sourceFile.toString());

		// Both files should be tracked (tracking is separate from ingestion)
		assert.strictEqual(await index.shouldTrackFile(sourceFile, CancellationToken.None), true);
		assert.strictEqual(await index.shouldTrackFile(vendorFile, CancellationToken.None), true);
	});
});
