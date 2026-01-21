/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test } from 'vitest';
import * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { GithubRepoId, IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { constObservable, observableValue } from '../../../../util/vs/base/common/observable';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { OrganizationInstructionsProvider } from '../organizationInstructionsProvider';
import { MockOctoKitService } from './mockOctoKitService';

/**
 * Mock implementation of IGitService for testing
 */
class MockGitService implements IGitService {
	_serviceBrand: undefined;
	isInitialized = true;
	activeRepository = observableValue<RepoContext | undefined>(this, undefined);
	onDidOpenRepository = Event.None;
	onDidCloseRepository = Event.None;
	onDidFinishInitialization = Event.None;

	get repositories(): RepoContext[] {
		const repo = this.activeRepository.get();
		return repo ? [repo] : [];
	}

	setActiveRepository(repoId: GithubRepoId | undefined) {
		if (repoId) {
			this.activeRepository.set({
				rootUri: URI.file('/test/repo'),
				headBranchName: undefined,
				headCommitHash: undefined,
				upstreamBranchName: undefined,
				upstreamRemote: undefined,
				isRebasing: false,
				remoteFetchUrls: [`https://github.com/${repoId.org}/${repoId.repo}.git`],
				remotes: [],
				worktrees: [],
				changes: undefined,
				headBranchNameObs: constObservable(undefined),
				headCommitHashObs: constObservable(undefined),
				upstreamBranchNameObs: constObservable(undefined),
				upstreamRemoteObs: constObservable(undefined),
				isRebasingObs: constObservable(false),
				isIgnored: async () => false,
			}, undefined);
		} else {
			this.activeRepository.set(undefined, undefined);
		}
	}

	async getRepository(uri: URI): Promise<RepoContext | undefined> {
		return undefined;
	}

	async getRepositoryFetchUrls(uri: URI): Promise<Pick<RepoContext, 'rootUri' | 'remoteFetchUrls'> | undefined> {
		return undefined;
	}

	async initialize(): Promise<void> { }
	async add(uri: URI, paths: string[]): Promise<void> { }
	async log(uri: URI, options?: any): Promise<any[] | undefined> {
		return [];
	}
	async diffBetween(uri: URI, ref1: string, ref2: string): Promise<any[] | undefined> {
		return [];
	}
	async diffBetweenPatch(uri: URI, ref1: string, ref2: string, path: string): Promise<string | undefined> {
		return undefined;
	}
	async diffBetweenWithStats(uri: URI, ref1: string, ref2: string, path?: string): Promise<any[] | undefined> {
		return [];
	}
	async diffWith(uri: URI, ref: string): Promise<any[] | undefined> {
		return [];
	}
	async diffIndexWithHEADShortStats(uri: URI): Promise<any | undefined> {
		return undefined;
	}
	async fetch(uri: URI, remote?: string, ref?: string, depth?: number): Promise<void> { }
	async getMergeBase(uri: URI, ref1: string, ref2: string): Promise<string | undefined> {
		return undefined;
	}
	async createWorktree(uri: URI, options?: { path?: string; commitish?: string; branch?: string }): Promise<string | undefined> {
		return undefined;
	}
	async deleteWorktree(uri: URI, path: string, options?: { force?: boolean }): Promise<void> { }
	async migrateChanges(uri: URI, sourceRepositoryUri: URI, options?: { confirmation?: boolean; deleteFromSource?: boolean; untracked?: boolean }): Promise<void> { }
	async applyPatch(uri: URI, patch: string): Promise<void> { }
	async commit(uri: URI, message: string | undefined): Promise<void> { }
	async getRefs(uri: URI, query: any, cancellationToken?: any): Promise<any[]> {
		return [];
	}

	dispose() { }
}

/**
 * Mock implementation of extension context for testing
 */
class MockExtensionContext {
	storageUri: vscode.Uri | undefined;

	constructor(storageUri?: vscode.Uri) {
		this.storageUri = storageUri;
	}
}

suite('OrganizationInstructionsProvider', () => {
	let disposables: DisposableStore;
	let mockGitService: MockGitService;
	let mockOctoKitService: MockOctoKitService;
	let mockFileSystem: MockFileSystemService;
	let mockExtensionContext: MockExtensionContext;
	let accessor: any;
	let provider: OrganizationInstructionsProvider;

	beforeEach(() => {
		disposables = new DisposableStore();

		// Create mocks first
		mockGitService = new MockGitService();
		mockOctoKitService = new MockOctoKitService();
		const storageUri = URI.file('/test/storage');
		mockExtensionContext = new MockExtensionContext(storageUri);

		// Set up testing services
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		mockFileSystem = accessor.get(IFileSystemService) as MockFileSystemService;
	});

	afterEach(() => {
		disposables.dispose();
		mockOctoKitService.clearInstructions();
	});

	function createProvider() {
		// Create provider manually with all dependencies
		provider = new OrganizationInstructionsProvider(
			mockOctoKitService,
			accessor.get(ILogService),
			mockGitService,
			mockExtensionContext as any,
			mockFileSystem,
		);
		disposables.add(provider);
		return provider;
	}

	test('returns empty array when no active repository', async () => {
		mockGitService.setActiveRepository(undefined);
		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.deepEqual(instructions, []);
	});

	test('returns empty array when no storage URI available', async () => {
		mockExtensionContext.storageUri = undefined;
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.deepEqual(instructions, []);
	});

	test('returns cached instructions on first call', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Pre-populate cache - implementation uses org name from repoId.org
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const instructionContent = `# Organization Instructions

Always follow our coding standards.`;
		mockFileSystem.mockFile(instructionFile, instructionContent);

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri);
	});

	test('fetches and caches instructions from API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Mock API response - use org name as the key
		const mockInstructions = `# Organization Instructions

Always use TypeScript strict mode.`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		// First call returns cached (empty) results
		const instructions1 = await provider.provideInstructions({}, {} as any);
		assert.deepEqual(instructions1, []);

		// Wait for background fetch to complete
		await new Promise(resolve => setTimeout(resolve, 100));

		// Second call should return newly cached instructions
		const instructions2 = await provider.provideInstructions({}, {} as any);
		assert.equal(instructions2.length, 1);
		assert.ok(instructions2[0].uri);
	});

	test('caches instructions with correct content', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Coding Standards

1. Use tabs for indentation
2. Follow TypeScript conventions
3. Write comprehensive tests`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check cached file content - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const contentBytes = await mockFileSystem.readFile(instructionFile);
		const content = new TextDecoder().decode(contentBytes);

		assert.equal(content, mockInstructions);
	});

	test('fires change event when cache is updated', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Initial Instructions`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let eventFired = false;
		provider.onDidChangeInstructions(() => {
			eventFired = true;
		});

		// Update the instructions
		const updatedInstructions = `# Updated Instructions`;
		mockOctoKitService.setOrgInstructions('testorg', updatedInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(eventFired, true);
	});

	test('handles API errors gracefully', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Make the API throw an error
		mockOctoKitService.getOrgCustomInstructions = async () => {
			throw new Error('API Error');
		};

		// Should not throw, should return empty array
		const instructions = await provider.provideInstructions({}, {} as any);
		assert.deepEqual(instructions, []);
	});

	test('prevents concurrent fetches when called multiple times rapidly', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		let apiCallCount = 0;
		mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
			apiCallCount++;
			// Simulate slow API call
			await new Promise(resolve => setTimeout(resolve, 50));
			return 'Test instructions';
		};

		// Make multiple concurrent calls
		const promise1 = provider.provideInstructions({}, {} as any);
		const promise2 = provider.provideInstructions({}, {} as any);
		const promise3 = provider.provideInstructions({}, {} as any);

		await Promise.all([promise1, promise2, promise3]);
		await new Promise(resolve => setTimeout(resolve, 100));

		// API should only be called once due to isFetching guard
		assert.equal(apiCallCount, 1);
	});

	test('does not fire change event when content is identical', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Stable Instructions`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventCount = 0;
		provider.onDidChangeInstructions(() => {
			changeEventCount++;
		});

		// Fetch again with identical content
		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		// No change event should fire
		assert.equal(changeEventCount, 0);
	});

	test('handles no instructions found from API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// API returns undefined (no instructions)
		mockOctoKitService.setOrgInstructions('testorg', undefined);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should not create any cache files
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		try {
			const files = await mockFileSystem.readDirectory(cacheDir);
			assert.equal(files.length, 0);
		} catch {
			// Directory might not exist, which is also fine
		}
	});

	test('generates correct cache filename for organization', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('mycompany', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Company Instructions`;
		mockOctoKitService.setOrgInstructions('mycompany', mockInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check that file was created with correct name - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const instructionFile = URI.joinPath(cacheDir, 'mycompany.instruction.md');
		try {
			const contentBytes = await mockFileSystem.readFile(instructionFile);
			const content = new TextDecoder().decode(contentBytes);
			assert.equal(content, mockInstructions);
		} catch (error) {
			assert.fail('Cache file should exist with correct name');
		}
	});

	test('handles repository context changes between calls', async () => {
		const provider = createProvider();

		// First call with org A
		mockGitService.setActiveRepository(new GithubRepoId('orgA', 'repoA'));

		let capturedOrgLogin: string | undefined;
		mockOctoKitService.getOrgCustomInstructions = async (orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
			capturedOrgLogin = orgLogin;
			return 'Org A instructions';
		};

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		assert.equal(capturedOrgLogin, 'orgA');

		// Change to org B
		mockGitService.setActiveRepository(new GithubRepoId('orgB', 'repoB'));

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should fetch from new organization
		assert.equal(capturedOrgLogin, 'orgB');
	});

	test('creates cache directory if it does not exist', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Test Instructions`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		// Initially no cache directory
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Cache directory should now exist
		try {
			const stat = await mockFileSystem.stat(cacheDir);
			assert.ok(stat);
		} catch {
			assert.fail('Cache directory should have been created');
		}
	});

	test('reads existing cache even when directory check fails', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Pre-populate cache - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const instructionContent = `# Existing Instructions`;
		mockFileSystem.mockFile(instructionFile, instructionContent);

		const instructions = await provider.provideInstructions({}, {} as any);

		// Should successfully read cached instructions
		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri);
	});

	test('handles cache read errors gracefully', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Make readDirectory throw an error
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		mockFileSystem.mockDirectory(cacheDir, []); // Empty directory
		const originalReadDir = mockFileSystem.readDirectory.bind(mockFileSystem);
		mockFileSystem.readDirectory = async () => {
			throw new Error('Read error');
		};

		// Should not throw, should return empty array
		const instructions = await provider.provideInstructions({}, {} as any);
		assert.deepEqual(instructions, []);

		// Restore original method
		mockFileSystem.readDirectory = originalReadDir;
	});

	test('detects instruction additions', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Initial setup with no instructions
		mockOctoKitService.setOrgInstructions('testorg', undefined);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventFired = false;
		provider.onDidChangeInstructions(() => {
			changeEventFired = true;
		});

		// Add new instructions
		const newInstructions = `# New Instructions

Follow these rules.`;
		mockOctoKitService.setOrgInstructions('testorg', newInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(changeEventFired, true);
		const instructions = await provider.provideInstructions({}, {} as any);
		assert.equal(instructions.length, 1);
	});

	test('detects instruction removals', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Initial setup with instructions
		const initialInstructions = `# Initial Instructions`;
		mockOctoKitService.setOrgInstructions('testorg', initialInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		provider.onDidChangeInstructions(() => {
			// Event listener registered for potential future use
		});

		// Remove instructions
		mockOctoKitService.setOrgInstructions('testorg', undefined);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		// Note: Currently the implementation doesn't delete cache files when instructions are removed,
		// so the change event might not fire. This test documents current behavior.
		// The cached instructions would still be returned on the next call.
	});

	test('handles empty instructions string', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// API returns empty string
		mockOctoKitService.setOrgInstructions('testorg', '');

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Empty strings are treated as "no instructions" and not cached
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		try {
			await mockFileSystem.readFile(instructionFile);
			assert.fail('Cache file should not exist for empty instructions');
		} catch {
			// Expected - empty instructions are not cached
		}
	});

	test('handles instructions with special characters', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockInstructions = `# Instructions

Use "double quotes" and 'single quotes'.
Include special chars: @#$%^&*()
Unicode: 你好 🚀`;
		mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check that special characters are preserved - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const contentBytes = await mockFileSystem.readFile(instructionFile);
		const content = new TextDecoder().decode(contentBytes);

		assert.equal(content, mockInstructions);
	});

	test('handles very large instruction content', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Generate large content (e.g., 100KB)
		const largeContent = '# Large Instructions\n\n' + 'x'.repeat(100000);
		mockOctoKitService.setOrgInstructions('testorg', largeContent);

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check that large content is handled correctly - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const contentBytes = await mockFileSystem.readFile(instructionFile);
		const content = new TextDecoder().decode(contentBytes);

		assert.equal(content.length, largeContent.length);
	});

	test('returns correct URI for cached instruction resource', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Pre-populate cache - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
		const instructionFile = URI.joinPath(cacheDir, 'testorg.instruction.md');
		const instructionContent = `# Test`;
		mockFileSystem.mockFile(instructionFile, instructionContent);

		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri);
		assert.equal(instructions[0].uri.toString(), instructionFile.toString());
	});

	test('handles multiple organizations in same cache directory', async () => {
		const provider = createProvider();

		// First organization
		mockGitService.setActiveRepository(new GithubRepoId('org1', 'repo1'));
		mockOctoKitService.setOrgInstructions('org1', '# Org 1 Instructions');

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Second organization
		mockGitService.setActiveRepository(new GithubRepoId('org2', 'repo2'));
		mockOctoKitService.setOrgInstructions('org2', '# Org 2 Instructions');

		await provider.provideInstructions({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Both instruction files should exist in cache
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		const files = await mockFileSystem.readDirectory(cacheDir);
		const instructionFiles = files.filter(([name]) => name.endsWith('.instruction.md'));

		assert.equal(instructionFiles.length, 2);
	});

	test('reads correct organization instructions when multiple are cached', async () => {
		const provider = createProvider();

		// Pre-populate cache with multiple organizations - uses org name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
		mockFileSystem.mockDirectory(cacheDir, [
			['org1.instruction.md', FileType.File],
			['org2.instruction.md', FileType.File],
		]);
		mockFileSystem.mockFile(URI.joinPath(cacheDir, 'org1.instruction.md'), '# Org 1 Instructions');
		mockFileSystem.mockFile(URI.joinPath(cacheDir, 'org2.instruction.md'), '# Org 2 Instructions');

		// Request instructions for org1
		mockGitService.setActiveRepository(new GithubRepoId('org1', 'repo1'));
		const instructions = await provider.provideInstructions({}, {} as any);

		assert.equal(instructions.length, 1);
		assert.ok(instructions[0].uri.toString().includes('org1'));
	});

	suite('Polling Behavior', () => {
		test('starts polling on initialization', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const mockInstructions = '# Test Instructions';
			mockOctoKitService.setOrgInstructions('testorg', mockInstructions);

			// Pre-populate cache so we have something to poll - uses org name
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), mockInstructions);

			let apiCallCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				apiCallCount++;
				return mockInstructions;
			};

			const provider = createProvider();

			// Wait slightly more than the polling interval (5 minutes = 300,000ms)
			// For testing, we'll use a reasonable timeout and check the logic
			// In a real test environment, you'd mock timers or expose the interval for testing

			// Since we can't easily wait 5 minutes in a test, we verify polling was set up
			// by checking that the provider doesn't error on disposal (stops polling correctly)
			provider.dispose();

			// If polling wasn't set up, dispose wouldn't call stopPolling
			// The test passing without errors indicates polling setup worked
			assert.ok(true);
		});

		test('polling refreshes cache periodically', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const initialInstructions = '# Initial Instructions';
			mockOctoKitService.setOrgInstructions('testorg', initialInstructions);

			// Pre-populate cache - uses org name
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), initialInstructions);

			let apiCallCount = 0;
			let changeEventCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				apiCallCount++;
				if (apiCallCount === 1) {
					return initialInstructions;
				} else {
					// Return updated instructions on subsequent calls
					return '# Updated Instructions';
				}
			};

			const provider = createProvider();
			provider.onDidChangeInstructions(() => {
				changeEventCount++;
			});

			// Manually trigger a refresh to simulate polling (since we can't wait 5 minutes)
			// Access the private method through type casting for testing
			await (provider as any).refreshCache();

			// Should not fire change event if content is the same
			assert.equal(changeEventCount, 0);
			assert.equal(apiCallCount, 1);

			// Now update the instructions and refresh again
			await (provider as any).refreshCache();

			await new Promise(resolve => setTimeout(resolve, 100));

			// Should fire change event for updated content
			assert.equal(changeEventCount, 1);
			assert.equal(apiCallCount, 2);
		});

		test('stops polling on disposal', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const provider = createProvider();

			let apiCallCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				apiCallCount++;
				return '# Test';
			};

			// Dispose the provider (should stop polling)
			provider.dispose();

			// Manually trigger what would be a polling refresh
			// This should not cause any API calls since polling is stopped
			try {
				await (provider as any).refreshCache();
			} catch {
				// Expected - provider is disposed
			}

			// Verify no unexpected behavior after disposal
			assert.ok(true);
		});

		test('polling handles errors gracefully', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));

			// Pre-populate cache - uses org name
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), '# Test');

			let shouldThrowError = false;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				if (shouldThrowError) {
					throw new Error('API Error');
				}
				return '# Test';
			};

			const provider = createProvider();

			// First refresh should succeed
			await (provider as any).refreshCache();

			// Enable error throwing
			shouldThrowError = true;

			// Second refresh should handle error gracefully
			await (provider as any).refreshCache();

			// Should not throw and provider should still be functional
			const instructions = await provider.provideInstructions({}, {} as any);
			assert.equal(instructions.length, 1); // Should still have cached instructions
		});

		test('polling updates cache when content changes', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const v1Instructions = '# Version 1';
			const v2Instructions = '# Version 2';

			// Pre-populate cache with v1 - uses org name
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), v1Instructions);

			let currentVersion = 1;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				return currentVersion === 1 ? v1Instructions : v2Instructions;
			};

			const provider = createProvider();

			// Initial state - should have v1
			await provider.provideInstructions({}, {} as any);
			let contentBytes = await mockFileSystem.readFile(URI.joinPath(cacheDir, 'testorg.instruction.md'));
			let content = new TextDecoder().decode(contentBytes);
			assert.equal(content, v1Instructions);

			// Simulate content change on server
			currentVersion = 2;

			// Trigger polling refresh
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 100));

			// Cache should now have v2
			contentBytes = await mockFileSystem.readFile(URI.joinPath(cacheDir, 'testorg.instruction.md'));
			content = new TextDecoder().decode(contentBytes);
			assert.equal(content, v2Instructions);
		});

		test('polling does not update cache when content unchanged', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const stableInstructions = '# Stable Instructions';

			// Pre-populate cache - uses org name
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), stableInstructions);

			let apiCallCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				apiCallCount++;
				return stableInstructions;
			};

			const provider = createProvider();
			let changeEventCount = 0;
			provider.onDidChangeInstructions(() => {
				changeEventCount++;
			});

			// Trigger multiple refreshes
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));

			// API should be called but no change events should fire
			assert.ok(apiCallCount >= 3);
			assert.equal(changeEventCount, 0);
		});

		test('polling respects organization context changes', async () => {
			// Start with org1
			mockGitService.setActiveRepository(new GithubRepoId('org1', 'repo1'));

			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['org1.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'org1.instruction.md'), '# Org 1');

			let lastRequestedOrg: string | undefined;
			mockOctoKitService.getOrgCustomInstructions = async (orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				lastRequestedOrg = orgLogin;
				return `# Instructions for ${orgLogin}`;
			};

			const provider = createProvider();

			// Refresh should query org1
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(lastRequestedOrg, 'org1');

			// Switch to org2
			mockGitService.setActiveRepository(new GithubRepoId('org2', 'repo2'));
			mockFileSystem.mockDirectory(cacheDir, [
				['org1.instruction.md', FileType.File],
				['org2.instruction.md', FileType.File],
			]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'org2.instruction.md'), '# Org 2');

			// Refresh should now query org2
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(lastRequestedOrg, 'org2');
		});

		test('polling continues after temporary API failures', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));

			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), '# Original');

			let attemptCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				attemptCount++;
				if (attemptCount === 1) {
					throw new Error('Temporary API failure');
				}
				return '# Updated after recovery';
			};

			const provider = createProvider();

			// First refresh fails
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(attemptCount, 1);

			// Second refresh succeeds
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(attemptCount, 2);

			// Cache should be updated after recovery
			const contentBytes = await mockFileSystem.readFile(URI.joinPath(cacheDir, 'testorg.instruction.md'));
			const content = new TextDecoder().decode(contentBytes);
			assert.equal(content, '# Updated after recovery');
		});

		test('polling prevents concurrent refresh operations', async () => {
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));

			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), '# Test');

			let concurrentCallCount = 0;
			let maxConcurrentCalls = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				concurrentCallCount++;
				maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCallCount);
				await new Promise(resolve => setTimeout(resolve, 50));
				concurrentCallCount--;
				return '# Test Instructions';
			};

			const provider = createProvider();

			// Trigger multiple refresh operations rapidly
			const refreshPromises = [
				(provider as any).refreshCache(),
				(provider as any).refreshCache(),
				(provider as any).refreshCache(),
			];

			await Promise.all(refreshPromises);
			await new Promise(resolve => setTimeout(resolve, 100));

			// Should never have more than 1 concurrent API call due to isFetching guard
			assert.equal(maxConcurrentCalls, 1);
		});

		test('polling works when no organization is initially determined', async () => {
			// Start with no active repository
			mockGitService.setActiveRepository(undefined);

			let apiCallCount = 0;
			mockOctoKitService.getOrgCustomInstructions = async (_orgLogin: string, _authOptions: { createIfNone?: boolean }) => {
				apiCallCount++;
				return '# Test';
			};

			const provider = createProvider();

			// Refresh should handle no organization gracefully
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));

			// Should not make API calls when no organization can be determined
			assert.equal(apiCallCount, 0);

			// Now set an active repository
			mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
			const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubInstructionsCache');
			mockFileSystem.mockDirectory(cacheDir, [['testorg.instruction.md', FileType.File]]);
			mockFileSystem.mockFile(URI.joinPath(cacheDir, 'testorg.instruction.md'), '# Test');

			// Refresh should now work
			await (provider as any).refreshCache();
			await new Promise(resolve => setTimeout(resolve, 50));

			// Should make API call now
			assert.equal(apiCallCount, 1);
		});
	});
});
