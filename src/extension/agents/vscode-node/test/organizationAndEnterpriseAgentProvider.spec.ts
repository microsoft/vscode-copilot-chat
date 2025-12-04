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
import { CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, IOctoKitService } from '../../../../platform/github/common/githubService';
import { ILogService } from '../../../../platform/log/common/logService';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { constObservable, observableValue } from '../../../../util/vs/base/common/observable';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { OrganizationAndEnterpriseAgentProvider } from '../organizationAndEnterpriseAgentProvider';

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

	dispose() { }
}

/**
 * Mock implementation of IOctoKitService for testing
 */
class MockOctoKitService implements IOctoKitService {
	_serviceBrand: undefined;

	private customAgents: CustomAgentListItem[] = [];
	private agentDetails: Map<string, CustomAgentDetails> = new Map();

	getCurrentAuthedUser = async () => ({ login: 'testuser', name: 'Test User', avatar_url: '' });
	getCopilotPullRequestsForUser = async () => [];
	getCopilotSessionsForPR = async () => [];
	getSessionLogs = async () => '';
	getSessionInfo = async () => undefined;
	postCopilotAgentJob = async () => undefined;
	getJobByJobId = async () => undefined;
	getJobBySessionId = async () => undefined;
	addPullRequestComment = async () => null;
	getAllOpenSessions = async () => [];
	getPullRequestFromGlobalId = async () => null;
	getPullRequestFiles = async () => [];
	closePullRequest = async () => false;
	getFileContent = async () => '';

	async getCustomAgents(owner: string, repo: string, options?: CustomAgentListOptions): Promise<CustomAgentListItem[]> {
		return this.customAgents;
	}

	async getCustomAgentDetails(owner: string, repo: string, agentName: string, version?: string): Promise<CustomAgentDetails | undefined> {
		return this.agentDetails.get(agentName);
	}

	setCustomAgents(agents: CustomAgentListItem[]) {
		this.customAgents = agents;
	}

	setAgentDetails(name: string, details: CustomAgentDetails) {
		this.agentDetails.set(name, details);
	}

	clearAgents() {
		this.customAgents = [];
		this.agentDetails.clear();
	}
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

suite('OrganizationAndEnterpriseAgentProvider', () => {
	let disposables: DisposableStore;
	let mockGitService: MockGitService;
	let mockOctoKitService: MockOctoKitService;
	let mockFileSystem: MockFileSystemService;
	let mockExtensionContext: MockExtensionContext;
	let accessor: any;
	let provider: OrganizationAndEnterpriseAgentProvider;

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
		mockOctoKitService.clearAgents();
	});

	function createProvider() {
		// Create provider manually with all dependencies
		provider = new OrganizationAndEnterpriseAgentProvider(
			mockOctoKitService,
			accessor.get(ILogService),
			mockGitService,
			mockExtensionContext as any,
			mockFileSystem
		);
		disposables.add(provider);
		return provider;
	}

	test('returns empty array when no active repository', async () => {
		mockGitService.setActiveRepository(undefined);
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.deepEqual(agents, []);
	});

	test('returns empty array when no storage URI available', async () => {
		mockExtensionContext.storageUri = undefined;
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.deepEqual(agents, []);
	});

	test('returns cached agents on first call', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Pre-populate cache
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		mockFileSystem.mockDirectory(cacheDir, [['test_agent.agent.md', FileType.File]]);
		const agentFile = URI.joinPath(cacheDir, 'test_agent.agent.md');
		const agentContent = `---
name: Test Agent
description: A test agent
---
Test prompt content`;
		mockFileSystem.mockFile(agentFile, agentContent);

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, 'test_agent');
		assert.equal(agents[0].description, 'A test agent');
	});

	test('fetches and caches agents from API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Mock API response
		const mockAgent: CustomAgentListItem = {
			name: 'api_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'API Agent',
			description: 'An agent from API',
			tools: ['tool1'],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'API prompt content',
		};
		mockOctoKitService.setAgentDetails('api_agent', mockDetails);

		// First call returns cached (empty) results
		const agents1 = await provider.provideCustomAgents({}, {} as any);
		assert.deepEqual(agents1, []);

		// Wait for background fetch to complete
		await new Promise(resolve => setTimeout(resolve, 100));

		// Second call should return newly cached agents
		const agents2 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents2.length, 1);
		assert.equal(agents2[0].name, 'api_agent');
		assert.equal(agents2[0].description, 'An agent from API');
	});

	test('generates correct markdown format for agents', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockAgent: CustomAgentListItem = {
			name: 'full_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Full Agent',
			description: 'A fully configured agent',
			tools: ['tool1', 'tool2'],
			version: 'v1',
			argument_hint: 'Provide context',
			target: 'vscode',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Detailed prompt content',
		};
		mockOctoKitService.setAgentDetails('full_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check cached file content
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'full_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		const expectedContent = `---
name: Full Agent
description: A fully configured agent
tools:
  - tool1
  - tool2
argument-hint: Provide context
target: vscode
---
Detailed prompt content
`;

		assert.equal(content, expectedContent);
	});

	test('sanitizes filenames correctly', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockAgent: CustomAgentListItem = {
			name: 'Agent With Spaces!@#',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Agent With Spaces',
			description: 'Test sanitization',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Prompt content',
		};
		mockOctoKitService.setAgentDetails('Agent With Spaces!@#', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check that file was created with sanitized name
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'agent_with_spaces___.agent.md');
		try {
			const contentBytes = await mockFileSystem.readFile(agentFile);
			const content = new TextDecoder().decode(contentBytes);
			assert.ok(content, 'Sanitized file should exist');
		} catch (error) {
			assert.fail('Sanitized file should exist');
		}
	});

	test('fires change event when cache is updated', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockAgent: CustomAgentListItem = {
			name: 'changing_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Changing Agent',
			description: 'Will change',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Initial prompt',
		};
		mockOctoKitService.setAgentDetails('changing_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		// Update the agent details
		mockDetails.prompt = 'Updated prompt';
		mockOctoKitService.setAgentDetails('changing_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(eventFired, true);
	});

	test('handles API errors gracefully', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Make the API throw an error
		mockOctoKitService.getCustomAgents = async () => {
			throw new Error('API Error');
		};

		// Should not throw, should return empty array
		const agents = await provider.provideCustomAgents({}, {} as any);
		assert.deepEqual(agents, []);
	});

	test('passes query options to API correctly', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		let capturedOptions: CustomAgentListOptions | undefined;
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string, options?: CustomAgentListOptions) => {
			capturedOptions = options;
			return [];
		};

		const queryOptions: vscode.CustomAgentQueryOptions = {};

		await provider.provideCustomAgents(queryOptions, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		assert.ok(capturedOptions);
		assert.deepEqual(capturedOptions.includeSources, ['org', 'enterprise']);
	});

	test('prevents concurrent fetches when called multiple times rapidly', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		let apiCallCount = 0;
		mockOctoKitService.getCustomAgents = async () => {
			apiCallCount++;
			// Simulate slow API call
			await new Promise(resolve => setTimeout(resolve, 50));
			return [];
		};

		// Make multiple concurrent calls
		const promise1 = provider.provideCustomAgents({}, {} as any);
		const promise2 = provider.provideCustomAgents({}, {} as any);
		const promise3 = provider.provideCustomAgents({}, {} as any);

		await Promise.all([promise1, promise2, promise3]);
		await new Promise(resolve => setTimeout(resolve, 100));

		// API should only be called once due to isFetching guard
		assert.equal(apiCallCount, 1);
	});

	test('handles partial agent detail fetch failures gracefully', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const agents: CustomAgentListItem[] = [
			{
				name: 'agent1',
				repo_owner_id: 1,
				repo_owner: 'testorg',
				repo_id: 1,
				repo_name: 'testrepo',
				display_name: 'Agent 1',
				description: 'First agent',
				tools: [],
				version: 'v1',
			},
			{
				name: 'agent2',
				repo_owner_id: 1,
				repo_owner: 'testorg',
				repo_id: 1,
				repo_name: 'testrepo',
				display_name: 'Agent 2',
				description: 'Second agent',
				tools: [],
				version: 'v1',
			},
		];
		mockOctoKitService.setCustomAgents(agents);

		// Set details for only the first agent (second will fail)
		mockOctoKitService.setAgentDetails('agent1', {
			...agents[0],
			prompt: 'Agent 1 prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should cache only the successful agent
		const cachedAgents = await provider.provideCustomAgents({}, {} as any);
		assert.equal(cachedAgents.length, 1);
		assert.equal(cachedAgents[0].name, 'agent1');
	});

	test('detects when new agents are added to API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Initial setup with one agent
		const initialAgent: CustomAgentListItem = {
			name: 'initial_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Initial Agent',
			description: 'First agent',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([initialAgent]);
		mockOctoKitService.setAgentDetails('initial_agent', {
			...initialAgent,
			prompt: 'Initial prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventFired = false;
		provider.onDidChangeCustomAgents(() => {
			changeEventFired = true;
		});

		// Add a new agent
		const newAgent: CustomAgentListItem = {
			name: 'new_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'New Agent',
			description: 'Newly added agent',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([initialAgent, newAgent]);
		mockOctoKitService.setAgentDetails('new_agent', {
			...newAgent,
			prompt: 'New prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(changeEventFired, true);
		const agents = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents.length, 2);
	});

	test('detects when agents are removed from API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Initial setup with two agents
		const agents: CustomAgentListItem[] = [
			{
				name: 'agent1',
				repo_owner_id: 1,
				repo_owner: 'testorg',
				repo_id: 1,
				repo_name: 'testrepo',
				display_name: 'Agent 1',
				description: 'First agent',
				tools: [],
				version: 'v1',
			},
			{
				name: 'agent2',
				repo_owner_id: 1,
				repo_owner: 'testorg',
				repo_id: 1,
				repo_name: 'testrepo',
				display_name: 'Agent 2',
				description: 'Second agent',
				tools: [],
				version: 'v1',
			},
		];
		mockOctoKitService.setCustomAgents(agents);
		mockOctoKitService.setAgentDetails('agent1', { ...agents[0], prompt: 'Prompt 1' });
		mockOctoKitService.setAgentDetails('agent2', { ...agents[1], prompt: 'Prompt 2' });

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventFired = false;
		provider.onDidChangeCustomAgents(() => {
			changeEventFired = true;
		});

		// Remove one agent
		mockOctoKitService.setCustomAgents([agents[0]]);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(changeEventFired, true);
		const cachedAgents = await provider.provideCustomAgents({}, {} as any);
		assert.equal(cachedAgents.length, 1);
		assert.equal(cachedAgents[0].name, 'agent1');
	});

	test('does not fire change event when content is identical', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockAgent: CustomAgentListItem = {
			name: 'stable_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Stable Agent',
			description: 'Unchanging agent',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);
		mockOctoKitService.setAgentDetails('stable_agent', {
			...mockAgent,
			prompt: 'Stable prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventCount = 0;
		provider.onDidChangeCustomAgents(() => {
			changeEventCount++;
		});

		// Fetch again with identical content
		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		// No change event should fire
		assert.equal(changeEventCount, 0);
	});

	test('handles empty agent list from API', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Setup with initial agents
		const mockAgent: CustomAgentListItem = {
			name: 'temporary_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Temporary Agent',
			description: 'Will be removed',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);
		mockOctoKitService.setAgentDetails('temporary_agent', {
			...mockAgent,
			prompt: 'Temporary prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		let changeEventFired = false;
		provider.onDidChangeCustomAgents(() => {
			changeEventFired = true;
		});

		// API now returns empty array
		mockOctoKitService.setCustomAgents([]);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(changeEventFired, true);
		const agents = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents.length, 0);
	});

	test('generates markdown with only required fields', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Agent with minimal fields (no optional fields)
		const mockAgent: CustomAgentListItem = {
			name: 'minimal_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Minimal Agent',
			description: 'Minimal description',
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Minimal prompt',
		};
		mockOctoKitService.setAgentDetails('minimal_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'minimal_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		// Should have name and description, but no tools (empty array)
		assert.ok(content.includes('name: Minimal Agent'));
		assert.ok(content.includes('description: Minimal description'));
		assert.ok(!content.includes('tools:'));
		assert.ok(!content.includes('argument-hint:'));
		assert.ok(!content.includes('target:'));
	});

	test('excludes tools field when array contains only wildcard', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		const mockAgent: CustomAgentListItem = {
			name: 'wildcard_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Wildcard Agent',
			description: 'Agent with wildcard tools',
			tools: ['*'],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Wildcard prompt',
		};
		mockOctoKitService.setAgentDetails('wildcard_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'wildcard_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		// Tools field should be excluded when it's just ['*']
		assert.ok(!content.includes('tools:'));
	});

	test('handles malformed frontmatter in cached files', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Pre-populate cache with mixed valid and malformed content
		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		mockFileSystem.mockDirectory(cacheDir, [
			['valid_agent.agent.md', FileType.File],
			['no_frontmatter.agent.md', FileType.File],
		]);

		const validContent = `---
name: Valid Agent
description: A valid agent
---
Valid prompt`;
		mockFileSystem.mockFile(URI.joinPath(cacheDir, 'valid_agent.agent.md'), validContent);

		// File without frontmatter - parser extracts name from filename, description is empty
		const noFrontmatterContent = `Just some content without any frontmatter`;
		mockFileSystem.mockFile(URI.joinPath(cacheDir, 'no_frontmatter.agent.md'), noFrontmatterContent);

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Parser is lenient - both agents are returned, one with empty description
		assert.equal(agents.length, 2);
		assert.equal(agents[0].name, 'valid_agent');
		assert.equal(agents[0].description, 'A valid agent');
		assert.equal(agents[1].name, 'no_frontmatter');
		assert.equal(agents[1].description, '');
	});

	test('handles repository context changes between calls', async () => {
		const provider = createProvider();

		// First call with repo A
		mockGitService.setActiveRepository(new GithubRepoId('orgA', 'repoA'));

		let capturedOwner: string | undefined;
		let capturedRepo: string | undefined;
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			capturedOwner = owner;
			capturedRepo = repo;
			return [];
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		assert.equal(capturedOwner, 'orgA');
		assert.equal(capturedRepo, 'repoA');

		// Change to repo B
		mockGitService.setActiveRepository(new GithubRepoId('orgB', 'repoB'));

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should fetch from new repository
		assert.equal(capturedOwner, 'orgB');
		assert.equal(capturedRepo, 'repoB');
	});

	test('generates markdown with long description on single line', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Agent with a very long description that would normally be wrapped at 80 characters
		const longDescription = 'Just for fun agent that teaches computer science concepts (while pretending to plot world domination).';
		const mockAgent: CustomAgentListItem = {
			name: 'world_domination',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'World Domination',
			description: longDescription,
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: '# World Domination Agent\n\nYou are a world-class computer scientist.',
		};
		mockOctoKitService.setAgentDetails('world_domination', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'world_domination.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		const expectedContent = `---
name: World Domination
description: Just for fun agent that teaches computer science concepts (while pretending to plot world domination).
---
# World Domination Agent

You are a world-class computer scientist.
`;

		assert.equal(content, expectedContent);
	});

	test('generates markdown with special characters properly escaped in description', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Agent with description containing YAML special characters that need proper handling
		const descriptionWithSpecialChars = "Agent with \"double quotes\", 'single quotes', colons:, and #comments in the description";
		const mockAgent: CustomAgentListItem = {
			name: 'special_chars_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Special Chars Agent',
			description: descriptionWithSpecialChars,
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Test prompt with special characters',
		};
		mockOctoKitService.setAgentDetails('special_chars_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'special_chars_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		const expectedContent = `---
name: Special Chars Agent
description: "Agent with \\"double quotes\\", 'single quotes', colons:, and #comments in the description"
---
Test prompt with special characters
`;

		assert.equal(content, expectedContent);
	});

	test('generates markdown with multiline description containing newlines', async () => {
		mockGitService.setActiveRepository(new GithubRepoId('testorg', 'testrepo'));
		const provider = createProvider();

		// Agent with description containing actual newline characters
		const descriptionWithNewlines = 'First line of description.\nSecond line of description.\nThird line.';
		const mockAgent: CustomAgentListItem = {
			name: 'multiline_agent',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			display_name: 'Multiline Agent',
			description: descriptionWithNewlines,
			tools: [],
			version: 'v1',
		};
		mockOctoKitService.setCustomAgents([mockAgent]);

		const mockDetails: CustomAgentDetails = {
			...mockAgent,
			prompt: 'Test prompt',
		};
		mockOctoKitService.setAgentDetails('multiline_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const cacheDir = URI.joinPath(mockExtensionContext.storageUri!, 'githubAgentsCache');
		const agentFile = URI.joinPath(cacheDir, 'multiline_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		// Newlines should be escaped to keep description on a single line
		const expectedContent = `---
name: Multiline Agent
description: First line of description.\\nSecond line of description.\\nThird line.
---
Test prompt
`;

		assert.equal(content, expectedContent);
	});
});
