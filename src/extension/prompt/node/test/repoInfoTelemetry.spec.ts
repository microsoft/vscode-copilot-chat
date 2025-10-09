/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { beforeEach, suite, test, vi } from 'vitest';
import type { FileSystemWatcher, Uri } from 'vscode';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../../../platform/authentication/common/copilotTokenStore';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IGitDiffService } from '../../../../platform/git/common/gitDiffService';
import { IGitExtensionService } from '../../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../../platform/git/common/gitService';
import { NullGitDiffService } from '../../../../platform/git/common/nullGitDiffService';
import { NullGitExtensionService } from '../../../../platform/git/common/nullGitExtensionService';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { createPlatformServices } from '../../../../platform/test/node/services';
import { Event } from '../../../../util/vs/base/common/event';
import { observableValue } from '../../../../util/vs/base/common/observableInternal/observables/observableValue';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { RepoInfoTelemetry } from '../repoInfoTelemetry';

// Import Status enum - use const enum values directly since vitest doesn't handle .d.ts well
const Status = {
	INDEX_MODIFIED: 0,
	INDEX_ADDED: 1,
	INDEX_DELETED: 2,
	INDEX_RENAMED: 3,
	INDEX_COPIED: 4,
	MODIFIED: 5,
	DELETED: 6,
	UNTRACKED: 7,
	IGNORED: 8,
	INTENT_TO_ADD: 9,
	INTENT_TO_RENAME: 10,
	TYPE_CHANGED: 11,
	ADDED_BY_US: 12,
	ADDED_BY_THEM: 13,
	DELETED_BY_US: 14,
	DELETED_BY_THEM: 15,
	BOTH_ADDED: 16,
	BOTH_DELETED: 17,
	BOTH_MODIFIED: 18
} as const;

suite('RepoInfoTelemetry', () => {
	let accessor: ReturnType<ReturnType<typeof createPlatformServices>['createTestingAccessor']>;
	let telemetryService: ITelemetryService;
	let gitService: IGitService;
	let gitDiffService: IGitDiffService;
	let gitExtensionService: IGitExtensionService;
	let copilotTokenStore: ICopilotTokenStore;
	let logService: ILogService;
	let fileSystemService: IFileSystemService;
	let mockWatcher: MockFileSystemWatcher;

	beforeEach(() => {
		const services = createPlatformServices();
		// Register extension-level services not in platform services by default
		services.define(IGitDiffService, new SyncDescriptor(NullGitDiffService));
		services.define(IGitExtensionService, new NullGitExtensionService());

		// Override IGitService with a proper mock that has an observable activeRepository
		const mockGitService: IGitService = {
			_serviceBrand: undefined,
			activeRepository: observableValue('test-git-activeRepo', undefined),
			onDidOpenRepository: Event.None,
			onDidCloseRepository: Event.None,
			onDidFinishInitialization: Event.None,
			repositories: [],
			isInitialized: true,
			getRepository: vi.fn(),
			getRepositoryFetchUrls: vi.fn(),
			initialize: vi.fn(),
			log: vi.fn(),
			diffBetween: vi.fn(),
			diffWith: vi.fn(),
			fetch: vi.fn(),
			getMergeBase: vi.fn(),
			dispose: vi.fn()
		};
		services.define(IGitService, mockGitService);

		accessor = services.createTestingAccessor();

		telemetryService = accessor.get(ITelemetryService);
		gitService = accessor.get(IGitService);
		gitDiffService = accessor.get(IGitDiffService);
		gitExtensionService = accessor.get(IGitExtensionService);
		copilotTokenStore = accessor.get(ICopilotTokenStore);
		logService = accessor.get(ILogService);
		fileSystemService = accessor.get(IFileSystemService);

		// Create a new mock watcher for each test
		mockWatcher = new MockFileSystemWatcher();

		// Mock the file system service to return our mock watcher
		vi.spyOn(fileSystemService, 'createFileSystemWatcher').mockReturnValue(mockWatcher as any);

		// Properly mock the sendInternalMSFTTelemetryEvent method
		(telemetryService as any).sendInternalMSFTTelemetryEvent = vi.fn();
	});

	// ========================================
	// Basic Telemetry Flow Tests
	// ========================================

	test('should only send telemetry for internal users', async () => {
		// Setup: non-internal user
		const nonInternalToken = new CopilotToken({
			token: 'test-token',
			sku: 'testSku',
			expires_at: 9999999999,
			refresh_in: 180000,
			chat_enabled: true,
			organization_list: [],
			isVscodeTeamMember: false,
			username: 'testUser',
			copilot_plan: 'unknown',
		});
		copilotTokenStore.copilotToken = nonInternalToken;

		// Setup: mock git service to have a repository
		mockGitServiceWithRepository();

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();
		await repoTelemetry.sendEndTelemetry();

		// Assert: no telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should send telemetry for internal users', async () => {
		// Setup: internal user
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');
		mockGitDiffService([{ uri: '/test/repo/file.ts', diff: 'some diff' }]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: begin telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[0], 'request.repoInfo');
		assert.strictEqual(call[1].location, 'begin');
		assert.strictEqual(call[1].telemetryMessageId, 'test-message-id');
	});

	test('should send begin telemetry only once', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');
		mockGitDiffService([{ uri: '/test/repo/file.ts', diff: 'some diff' }]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();
		await repoTelemetry.sendBeginTelemetryIfNeeded();
		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: only one begin telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
	});

	test('should send end telemetry after begin', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');
		mockGitDiffService([{ uri: '/test/repo/file.ts', diff: 'some diff' }]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();
		await repoTelemetry.sendEndTelemetry();

		// Assert: both begin and end telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 2);
		const beginCall = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		const endCall = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[1];

		assert.strictEqual(beginCall[1].location, 'begin');
		assert.strictEqual(endCall[1].location, 'end');
		assert.strictEqual(beginCall[1].telemetryMessageId, endCall[1].telemetryMessageId);
	});

	// ========================================
	// Git Repository Detection Tests
	// ========================================

	test('should not send telemetry when no active repository', async () => {
		setupInternalUser();

		// Mock: no active repository
		vi.spyOn(gitService.activeRepository, 'get').mockReturnValue(undefined);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should not send telemetry when no changes in repository', async () => {
		setupInternalUser();

		// Mock: repository with no changes
		vi.spyOn(gitService.activeRepository, 'get').mockReturnValue({
			rootUri: URI.file('/test/repo'),
			changes: undefined,
		} as any);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should not send telemetry when no GitHub remote', async () => {
		setupInternalUser();

		// Mock: repository with changes but no GitHub remote
		vi.spyOn(gitService.activeRepository, 'get').mockReturnValue({
			rootUri: URI.file('/test/repo'),
			changes: {
				mergeChanges: [],
				indexChanges: [],
				workingTree: [],
				untrackedChanges: []
			},
			remotes: [],
			remoteFetchUrls: [],
			upstreamRemote: undefined,
		} as any);

		mockGitExtensionWithUpstream('abc123', 'https://gitlab.com/user/repo.git');

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should not send telemetry when no upstream commit', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();

		// Mock: no upstream commit
		mockGitExtensionWithUpstream(undefined);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should send telemetry with valid GitHub repository', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123def456');
		mockGitDiffService([{ uri: '/test/repo/file.ts', diff: 'some diff' }]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: telemetry sent with correct properties
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[0], 'request.repoInfo');
		assert.strictEqual(call[1].remoteUrl, 'https://github.com/microsoft/vscode.git');
		assert.strictEqual(call[1].headCommitHash, 'abc123def456');
		assert.strictEqual(call[1].result, 'success');
	});

	// ========================================
	// File System Watching Tests
	// ========================================

	test('should detect file creation during diff', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		// Mock git diff to trigger file change during execution
		vi.spyOn(gitService, 'diffWith').mockImplementation(async () => {
			// Simulate file creation during diff
			mockWatcher.triggerCreate(URI.file('/test/repo/newfile.ts') as any);
			return [{
				uri: URI.file('/test/repo/file.ts'),
				originalUri: URI.file('/test/repo/file.ts'),
				renameUri: undefined,
				status: Status.MODIFIED
			}] as any;
		});

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: filesChanged result
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'filesChanged');
		assert.strictEqual(call[1].diffsJSON, undefined);
	});

	test('should detect file modification during diff', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		// Mock git diff to trigger file change during execution
		vi.spyOn(gitService, 'diffWith').mockImplementation(async () => {
			// Simulate file modification during diff
			mockWatcher.triggerChange(URI.file('/test/repo/file.ts') as any);
			return [{
				uri: URI.file('/test/repo/file.ts'),
				originalUri: URI.file('/test/repo/file.ts'),
				renameUri: undefined,
				status: Status.MODIFIED
			}] as any;
		});

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: filesChanged result
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'filesChanged');
		assert.strictEqual(call[1].diffsJSON, undefined);
	});

	test('should detect file deletion during diff', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		// Mock git diff to trigger file change during execution
		vi.spyOn(gitService, 'diffWith').mockImplementation(async () => {
			// Simulate file deletion during diff
			mockWatcher.triggerDelete(URI.file('/test/repo/oldfile.ts') as any);
			return [{
				uri: URI.file('/test/repo/file.ts'),
				originalUri: URI.file('/test/repo/file.ts'),
				renameUri: undefined,
				status: Status.DELETED
			}] as any;
		});

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: filesChanged result
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'filesChanged');
		assert.strictEqual(call[1].diffsJSON, undefined);
	});

	test('should detect file change during diff processing', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED
		}] as any);

		// Mock git diff service to trigger file change during processing
		vi.spyOn(gitDiffService, 'getChangeDiffs').mockImplementation(async () => {
			// Simulate file change during diff processing
			mockWatcher.triggerChange(URI.file('/test/repo/file.ts') as any);
			return [{
				uri: URI.file('/test/repo/file.ts'),
				originalUri: URI.file('/test/repo/file.ts'),
				renameUri: undefined,
				status: Status.MODIFIED,
				diff: 'some diff content'
			}];
		});

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: filesChanged result
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'filesChanged');
		assert.strictEqual(call[1].diffsJSON, undefined);
	});

	test('should properly dispose file watcher', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');
		mockGitDiffService([]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: watcher was disposed
		assert.strictEqual(mockWatcher.isDisposed, true);
	});

	// ========================================
	// Diff Too Big Tests
	// ========================================

	test('should detect when diff is too large', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED
		}] as any);

		// Create a diff that exceeds 900KB when serialized to JSON
		const largeDiff = 'x'.repeat(901 * 1024);
		vi.spyOn(gitDiffService, 'getChangeDiffs').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED,
			diff: largeDiff
		}]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: diffTooLarge result
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'diffTooLarge');
		assert.strictEqual(call[1].diffsJSON, undefined);
		assert.strictEqual(call[1].remoteUrl, 'https://github.com/microsoft/vscode.git');
		assert.strictEqual(call[1].headCommitHash, 'abc123');
	});

	test('should send diff when within size limits', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED
		}] as any);

		// Create a diff that is within limits
		const normalDiff = 'some normal diff content';
		vi.spyOn(gitDiffService, 'getChangeDiffs').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED,
			diff: normalDiff
		}]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: success with diff
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'success');
		assert.ok(call[1].diffsJSON);

		const diffs = JSON.parse(call[1].diffsJSON);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].diff, normalDiff);
	});

	test('should handle multiple files in diff', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([
			{
				uri: URI.file('/test/repo/file1.ts'),
				originalUri: URI.file('/test/repo/file1.ts'),
				renameUri: undefined,
				status: Status.MODIFIED
			},
			{
				uri: URI.file('/test/repo/file2.ts'),
				originalUri: URI.file('/test/repo/file2.ts'),
				renameUri: undefined,
				status: Status.INDEX_ADDED
			},
			{
				uri: URI.file('/test/repo/file3.ts'),
				originalUri: URI.file('/test/repo/file3.ts'),
				renameUri: undefined,
				status: Status.DELETED
			}
		] as any);

		vi.spyOn(gitDiffService, 'getChangeDiffs').mockResolvedValue([
			{
				uri: URI.file('/test/repo/file1.ts'),
				originalUri: URI.file('/test/repo/file1.ts'),
				renameUri: undefined,
				status: Status.MODIFIED,
				diff: 'diff for file1'
			},
			{
				uri: URI.file('/test/repo/file2.ts'),
				originalUri: URI.file('/test/repo/file2.ts'),
				renameUri: undefined,
				status: Status.INDEX_ADDED,
				diff: 'diff for file2'
			},
			{
				uri: URI.file('/test/repo/file3.ts'),
				originalUri: URI.file('/test/repo/file3.ts'),
				renameUri: undefined,
				status: Status.DELETED,
				diff: 'diff for file3'
			}
		]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: success with all diffs
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'success');

		const diffs = JSON.parse(call[1].diffsJSON);
		assert.strictEqual(diffs.length, 3);
		assert.strictEqual(diffs[0].status, Status.MODIFIED);
		assert.strictEqual(diffs[1].status, Status.INDEX_ADDED);
		assert.strictEqual(diffs[2].status, Status.DELETED);
	});

	test('should handle renamed files in diff', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([{
			uri: URI.file('/test/repo/newname.ts'),
			originalUri: URI.file('/test/repo/oldname.ts'),
			renameUri: URI.file('/test/repo/newname.ts'),
			status: Status.INDEX_RENAMED
		}] as any);

		vi.spyOn(gitDiffService, 'getChangeDiffs').mockResolvedValue([{
			uri: URI.file('/test/repo/newname.ts'),
			originalUri: URI.file('/test/repo/oldname.ts'),
			renameUri: URI.file('/test/repo/newname.ts'),
			status: Status.INDEX_RENAMED,
			diff: 'diff content'
		}]);

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: success with rename info
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 1);
		const call = (telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls[0];
		assert.strictEqual(call[1].result, 'success');

		const diffs = JSON.parse(call[1].diffsJSON);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].status, Status.INDEX_RENAMED);
		assert.ok(diffs[0].renameUri);
	});

	// ========================================
	// Error Handling Tests
	// ========================================

	test('should handle errors during git diff gracefully', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		// Mock git diff to throw error
		vi.spyOn(gitService, 'diffWith').mockRejectedValue(new Error('Git error'));

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		// Should not throw
		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent due to error
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	test('should handle errors during diff processing gracefully', async () => {
		setupInternalUser();
		mockGitServiceWithRepository();
		mockGitExtensionWithUpstream('abc123');

		vi.spyOn(gitService, 'diffWith').mockResolvedValue([{
			uri: URI.file('/test/repo/file.ts'),
			originalUri: URI.file('/test/repo/file.ts'),
			renameUri: undefined,
			status: Status.MODIFIED
		}] as any);

		// Mock diff service to throw error
		vi.spyOn(gitDiffService, 'getChangeDiffs').mockRejectedValue(new Error('Diff processing error'));

		const repoTelemetry = new RepoInfoTelemetry(
			'test-message-id',
			telemetryService,
			gitService,
			gitDiffService,
			gitExtensionService,
			copilotTokenStore,
			logService,
			fileSystemService
		);

		// Should not throw
		await repoTelemetry.sendBeginTelemetryIfNeeded();

		// Assert: no telemetry sent due to error
		assert.strictEqual((telemetryService.sendInternalMSFTTelemetryEvent as any).mock.calls.length, 0);
	});

	// ========================================
	// Helper Functions
	// ========================================

	function setupInternalUser() {
		const internalToken = new CopilotToken({
			token: 'tid=test;rt=1',
			sku: 'testSku',
			expires_at: 9999999999,
			refresh_in: 180000,
			chat_enabled: true,
			organization_list: ['4535c7beffc844b46bb1ed4aa04d759a'], // GitHub org for internal users
			isVscodeTeamMember: true,
			username: 'testUser',
			copilot_plan: 'unknown',
		});
		copilotTokenStore.copilotToken = internalToken;
	}

	function mockGitServiceWithRepository() {
		vi.spyOn(gitService.activeRepository, 'get').mockReturnValue({
			rootUri: URI.file('/test/repo'),
			changes: {
				mergeChanges: [],
				indexChanges: [],
				workingTree: [{
					uri: URI.file('/test/repo/file.ts'),
					originalUri: URI.file('/test/repo/file.ts'),
					renameUri: undefined,
					status: Status.MODIFIED
				}],
				untrackedChanges: []
			},
			remotes: ['origin'],
			remoteFetchUrls: ['https://github.com/microsoft/vscode.git'],
			upstreamRemote: 'origin',
			headBranchName: 'main',
			headCommitHash: 'abc123',
			upstreamBranchName: 'origin/main',
			isRebasing: false,
		} as any);
	}

	function mockGitExtensionWithUpstream(upstreamCommit: string | undefined, remoteUrl: string = 'https://github.com/microsoft/vscode.git') {
		const mockApi = {
			getRepository: () => ({
				state: {
					HEAD: {
						upstream: upstreamCommit ? {
							commit: upstreamCommit,
							remote: 'origin',
						} : undefined,
					},
					remotes: [{
						name: 'origin',
						fetchUrl: remoteUrl,
						pushUrl: remoteUrl,
						isReadOnly: false,
					}],
				},
			}),
		};
		vi.spyOn(gitExtensionService, 'getExtensionApi').mockReturnValue(mockApi as any);
	}

	function mockGitDiffService(diffs: any[]) {
		// Mock diffWith to return Change objects
		const changes = diffs.map(d => ({
			uri: URI.file(d.uri || '/test/repo/file.ts'),
			originalUri: URI.file(d.originalUri || d.uri || '/test/repo/file.ts'),
			renameUri: d.renameUri ? URI.file(d.renameUri) : undefined,
			status: d.status || Status.MODIFIED
		}));

		vi.spyOn(gitService, 'diffWith').mockResolvedValue(
			diffs.length > 0 ? changes as any : []
		);

		// Mock getChangeDiffs to return Diff objects (Change + diff property)
		vi.spyOn(gitDiffService, 'getChangeDiffs').mockResolvedValue(
			diffs.map(d => ({
				uri: URI.file(d.uri || '/test/repo/file.ts'),
				originalUri: URI.file(d.originalUri || d.uri || '/test/repo/file.ts'),
				renameUri: d.renameUri ? URI.file(d.renameUri) : undefined,
				status: d.status || Status.MODIFIED,
				diff: d.diff || 'test diff'
			}))
		);
	}
});

// ========================================
// Mock File System Watcher
// ========================================

class MockFileSystemWatcher implements FileSystemWatcher {
	private _createHandlers: ((e: Uri) => any)[] = [];
	private _changeHandlers: ((e: Uri) => any)[] = [];
	private _deleteHandlers: ((e: Uri) => any)[] = [];
	public isDisposed = false;
	public ignoreCreateEvents = false;
	public ignoreChangeEvents = false;
	public ignoreDeleteEvents = false;

	get onDidCreate(): Event<Uri> {
		return (listener) => {
			this._createHandlers.push(listener);
			return {
				dispose: () => {
					const index = this._createHandlers.indexOf(listener);
					if (index > -1) {
						this._createHandlers.splice(index, 1);
					}
				}
			};
		};
	}

	get onDidChange(): Event<Uri> {
		return (listener) => {
			this._changeHandlers.push(listener);
			return {
				dispose: () => {
					const index = this._changeHandlers.indexOf(listener);
					if (index > -1) {
						this._changeHandlers.splice(index, 1);
					}
				}
			};
		};
	}

	get onDidDelete(): Event<Uri> {
		return (listener) => {
			this._deleteHandlers.push(listener);
			return {
				dispose: () => {
					const index = this._deleteHandlers.indexOf(listener);
					if (index > -1) {
						this._deleteHandlers.splice(index, 1);
					}
				}
			};
		};
	}

	triggerCreate(uri: Uri): void {
		this._createHandlers.forEach(h => h(uri));
	}

	triggerChange(uri: Uri): void {
		this._changeHandlers.forEach(h => h(uri));
	}

	triggerDelete(uri: Uri): void {
		this._deleteHandlers.forEach(h => h(uri));
	}

	dispose(): void {
		this.isDisposed = true;
		this._createHandlers = [];
		this._changeHandlers = [];
		this._deleteHandlers = [];
	}
}
