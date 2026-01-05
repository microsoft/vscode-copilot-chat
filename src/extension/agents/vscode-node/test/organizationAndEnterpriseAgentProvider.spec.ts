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
import { CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, IOctoKitService, PermissiveAuthRequiredError } from '../../../../platform/github/common/githubService';
import { ILogService } from '../../../../platform/log/common/logService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { OrganizationAndEnterpriseAgentProvider } from '../organizationAndEnterpriseAgentProvider';

/**
 * Mock implementation of IOctoKitService for testing
 */
class MockOctoKitService implements IOctoKitService {
	_serviceBrand: undefined;

	private customAgents: CustomAgentListItem[] = [];
	private agentDetails: Map<string, CustomAgentDetails> = new Map();

	private userOrganizations: string[] = ['testorg'];

	getCurrentAuthedUser = async () => ({ login: 'testuser', name: 'Test User', avatar_url: '' });
	getCopilotPullRequestsForUser = async () => [];
	getCopilotSessionsForPR = async () => [];
	getSessionLogs = async () => '';
	getSessionInfo = async () => undefined;
	postCopilotAgentJob = async () => undefined;
	getJobByJobId = async () => undefined;
	getJobBySessionId = async () => undefined;
	addPullRequestComment = async () => null;
	getAllSessions = async () => [];
	getPullRequestFromGlobalId = async () => null;
	getPullRequestFiles = async () => [];
	closePullRequest = async () => false;
	getFileContent = async () => '';
	getUserOrganizations = async () => this.userOrganizations;
	getOrganizationRepositories = async (org: string) => [org === 'testorg' ? 'testrepo' : 'repo'];

	async getCustomAgents(owner: string, repo: string, options: CustomAgentListOptions, authOptions: { createIfNone?: boolean }): Promise<CustomAgentListItem[]> {
		if (!(await this.getCurrentAuthedUser())) {
			throw new PermissiveAuthRequiredError();
		}
		return this.customAgents;
	}

	async getCustomAgentDetails(owner: string, repo: string, agentName: string, version: string, authOptions: { createIfNone?: boolean }): Promise<CustomAgentDetails | undefined> {
		return this.agentDetails.get(agentName);
	}

	setCustomAgents(agents: CustomAgentListItem[]) {
		this.customAgents = agents;
	}

	setAgentDetails(name: string, details: CustomAgentDetails) {
		this.agentDetails.set(name, details);
	}

	setUserOrganizations(orgs: string[]) {
		this.userOrganizations = orgs;
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
	globalStorageUri: vscode.Uri | undefined;

	constructor(globalStorageUri?: vscode.Uri) {
		this.globalStorageUri = globalStorageUri;
	}
}

suite('OrganizationAndEnterpriseAgentProvider', () => {
	let disposables: DisposableStore;
	let mockOctoKitService: MockOctoKitService;
	let mockFileSystem: MockFileSystemService;
	let mockExtensionContext: MockExtensionContext;
	let accessor: any;
	let provider: OrganizationAndEnterpriseAgentProvider;

	beforeEach(() => {
		disposables = new DisposableStore();

		// Create mocks first
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
			mockExtensionContext as any,
			mockFileSystem,
		);
		disposables.add(provider);
		return provider;
	}

	test('returns empty array when user has no organizations', async () => {
		mockOctoKitService.setUserOrganizations([]);
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.deepEqual(agents, []);
	});

	test('returns empty array when no storage URI available', async () => {
		mockExtensionContext.globalStorageUri = undefined;
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.deepEqual(agents, []);
	});

	test('returns cached agents on first call', async () => {
		const provider = createProvider();

		// Pre-populate cache with org folder
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		mockFileSystem.mockDirectory(cacheDir, [['testorg', FileType.Directory]]);
		mockFileSystem.mockDirectory(orgDir, [['test_agent.agent.md', FileType.File]]);
		const agentFile = URI.joinPath(orgDir, 'test_agent.agent.md');
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

		// First call returns cached (empty) results and triggers background fetch
		const agents1 = await provider.provideCustomAgents({}, {} as any);
		assert.deepEqual(agents1, []);

		// Wait for background fetch to complete
		await new Promise(resolve => setTimeout(resolve, 100));

		// Second call should return newly cached agents from memory
		const agents2 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents2.length, 1);
		assert.equal(agents2[0].name, 'api_agent');
		assert.equal(agents2[0].description, 'An agent from API');

		// Third call should also return from memory cache without file I/O
		const agents3 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents3.length, 1);
		assert.equal(agents3[0].name, 'api_agent');
	});

	test('generates correct markdown format for agents', async () => {
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
			model: 'gpt-4',
			infer: true,
		};
		mockOctoKitService.setAgentDetails('full_agent', mockDetails);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Check cached file content
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'full_agent.agent.md');
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
model: gpt-4
infer: true
---
Detailed prompt content
`;

		assert.equal(content, expectedContent);
	});

	test('sanitizes filenames correctly', async () => {
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
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'agent_with_spaces___.agent.md');
		try {
			const contentBytes = await mockFileSystem.readFile(agentFile);
			const content = new TextDecoder().decode(contentBytes);
			assert.ok(content, 'Sanitized file should exist');
		} catch (error) {
			assert.fail('Sanitized file should exist');
		}
	});

	test('fires change event when cache is updated on first fetch', async () => {
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

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		// First call triggers background fetch
		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 150));

		// Event should fire after initial successful fetch
		assert.equal(eventFired, true);
	});

	test('handles API errors gracefully', async () => {
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

		// Pre-populate file cache with the first agent to simulate previous successful state
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		mockFileSystem.mockDirectory(cacheDir, [['testorg', FileType.Directory]]);
		mockFileSystem.mockDirectory(orgDir, [['agent1.agent.md', FileType.File]]);
		const agentContent = `---
name: Agent 1
description: First agent
---
Agent 1 prompt`;
		mockFileSystem.mockFile(URI.joinPath(orgDir, 'agent1.agent.md'), agentContent);

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// With error handling, partial failures skip cache update for that org
		// So the existing file cache is returned with the one successful agent
		const cachedAgents = await provider.provideCustomAgents({}, {} as any);
		assert.equal(cachedAgents.length, 1);
		assert.equal(cachedAgents[0].name, 'agent1');
	});

	test('caches agents in memory after first successful fetch', async () => {
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

		// After successful fetch, subsequent calls return from memory
		const agents1 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents1.length, 1);
		assert.equal(agents1[0].name, 'initial_agent');

		// Even if API is updated, memory cache is used
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

		// Memory cache returns old results without refetching
		const agents2 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents2.length, 1);
		assert.equal(agents2[0].name, 'initial_agent');
	});

	test('memory cache persists after first successful fetch', async () => {
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

		// Verify both agents are cached
		const cachedAgents1 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(cachedAgents1.length, 2);

		// Remove one agent from API
		mockOctoKitService.setCustomAgents([agents[0]]);

		// Memory cache still returns both agents (no refetch)
		const cachedAgents2 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(cachedAgents2.length, 2);
		assert.equal(cachedAgents2[0].name, 'agent1');
		assert.equal(cachedAgents2[1].name, 'agent2');
	});

	test('does not fire change event when content is identical', async () => {
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

	test('memory cache persists even when API returns empty list', async () => {
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

		// Verify agent is cached
		const agents1 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents1.length, 1);

		// API now returns empty array
		mockOctoKitService.setCustomAgents([]);

		// Memory cache still returns the agent (no refetch)
		const agents2 = await provider.provideCustomAgents({}, {} as any);
		assert.equal(agents2.length, 1);
		assert.equal(agents2[0].name, 'temporary_agent');
	});

	test('generates markdown with only required fields', async () => {
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

		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'minimal_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		// Should have name and description, but no tools (empty array)
		assert.ok(content.includes('name: Minimal Agent'));
		assert.ok(content.includes('description: Minimal description'));
		assert.ok(!content.includes('tools:'));
		assert.ok(!content.includes('argument-hint:'));
		assert.ok(!content.includes('target:'));
		assert.ok(!content.includes('model:'));
		assert.ok(!content.includes('infer:'));
	});

	test('excludes tools field when array contains only wildcard', async () => {
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

		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'wildcard_agent.agent.md');
		const contentBytes = await mockFileSystem.readFile(agentFile);
		const content = new TextDecoder().decode(contentBytes);

		// Tools field should be excluded when it's just ['*']
		assert.ok(!content.includes('tools:'));
	});

	test('handles malformed frontmatter in cached files', async () => {
		const provider = createProvider();

		// Pre-populate cache with mixed valid and malformed content
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		mockFileSystem.mockDirectory(cacheDir, [['testorg', FileType.Directory]]);
		mockFileSystem.mockDirectory(orgDir, [
			['valid_agent.agent.md', FileType.File],
			['no_frontmatter.agent.md', FileType.File],
		]);

		const validContent = `---
name: Valid Agent
description: A valid agent
---
Valid prompt`;
		mockFileSystem.mockFile(URI.joinPath(orgDir, 'valid_agent.agent.md'), validContent);

		// File without frontmatter - parser extracts name from filename, description is empty
		const noFrontmatterContent = `Just some content without any frontmatter`;
		mockFileSystem.mockFile(URI.joinPath(orgDir, 'no_frontmatter.agent.md'), noFrontmatterContent);

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Parser is lenient - both agents are returned, one with empty description
		assert.equal(agents.length, 2);
		assert.equal(agents[0].name, 'valid_agent');
		assert.equal(agents[0].description, 'A valid agent');
		assert.equal(agents[1].name, 'no_frontmatter');
		assert.equal(agents[1].description, '');
	});

	test('fetches agents from all user organizations', async () => {
		const provider = createProvider();

		// Set up multiple organizations
		mockOctoKitService.setUserOrganizations(['orgA', 'orgB', 'orgC']);

		const capturedOrgs: string[] = [];
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			capturedOrgs.push(owner);
			return [];
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should have fetched from all three organizations
		assert.equal(capturedOrgs.length, 3);
		assert.ok(capturedOrgs.includes('orgA'));
		assert.ok(capturedOrgs.includes('orgB'));
		assert.ok(capturedOrgs.includes('orgC'));
	});

	test('generates markdown with long description on single line', async () => {
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

		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'world_domination.agent.md');
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
		const provider = createProvider();

		// Agent with description containing YAML special characters that need proper handling
		const descriptionWithSpecialChars = `Agent with "double quotes", 'single quotes', colons:, and #comments in the description`;
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

		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'special_chars_agent.agent.md');
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

		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgDir = URI.joinPath(cacheDir, 'testorg');
		const agentFile = URI.joinPath(orgDir, 'multiline_agent.agent.md');
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

	test('aborts fetch if user signs out during process', async () => {
		const provider = createProvider();

		// Setup multiple organizations to ensure we have multiple steps
		mockOctoKitService.setUserOrganizations(['org1', 'org2']);
		mockOctoKitService.getOrganizationRepositories = async (org) => ['repo'];

		// Mock getCustomAgents to simulate sign out after first org
		let callCount = 0;
		const originalGetCustomAgents = mockOctoKitService.getCustomAgents;
		mockOctoKitService.getCustomAgents = async (owner, repo, options) => {
			callCount++;
			if (callCount === 1) {
				// Sign out user after first call
				mockOctoKitService.getCurrentAuthedUser = async () => undefined as any;
			}
			return originalGetCustomAgents.call(mockOctoKitService, owner, repo, options, { createIfNone: false });
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		// Should have aborted after first org, so second org shouldn't be processed
		assert.equal(callCount, 1);
	});

	test('deduplicates enterprise agents that appear in multiple organizations', async () => {
		const provider = createProvider();

		// Setup multiple organizations
		mockOctoKitService.setUserOrganizations(['orgA', 'orgB']);

		// Create an enterprise agent that will appear in both organizations
		const enterpriseAgent: CustomAgentListItem = {
			name: 'enterprise_agent',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Enterprise Agent',
			description: 'Shared enterprise agent',
			tools: [],
			version: 'v1.0',
		};

		// Mock getCustomAgents to return the same enterprise agent for both orgs
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			// Both orgs return the same enterprise agent (same repo_owner, repo_name, name, version)
			return [enterpriseAgent];
		};

		mockOctoKitService.setAgentDetails('enterprise_agent', {
			...enterpriseAgent,
			prompt: 'Enterprise prompt',
		});

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Should only have one agent, not two (deduped)
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, 'enterprise_agent');

		// Verify it was only written to one org directory
		const cacheDir = URI.joinPath(mockExtensionContext.globalStorageUri!, 'githubAgentsCache');
		const orgADir = URI.joinPath(cacheDir, 'orga');
		const orgBDir = URI.joinPath(cacheDir, 'orgb');

		// Check which org has the agent file
		let orgAHasAgent = false;
		let orgBHasAgent = false;

		try {
			const file = await mockFileSystem.readFile(URI.joinPath(orgADir, 'enterprise_agent.agent.md'));
			orgAHasAgent = file !== undefined;
		} catch {
			// File doesn't exist in orgA
		}

		try {
			const file = await mockFileSystem.readFile(URI.joinPath(orgBDir, 'enterprise_agent.agent.md'));
			orgBHasAgent = file !== undefined;
		} catch {
			// File doesn't exist in orgB
		}

		// Agent should be in exactly one org directory (the first one processed)
		assert.ok(orgAHasAgent && !orgBHasAgent, 'Enterprise agent should only be cached in first org');
	});

	test('deduplicates agents with same repo regardless of version', async () => {
		const provider = createProvider();

		mockOctoKitService.setUserOrganizations(['orgA', 'orgB']);

		// Create agents with same name but different versions
		const agentV1: CustomAgentListItem = {
			name: 'versioned_agent',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Versioned Agent',
			description: 'Agent version 1',
			tools: [],
			version: 'v1.0',
		};

		const agentV2: CustomAgentListItem = {
			name: 'versioned_agent',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Versioned Agent',
			description: 'Agent version 2',
			tools: [],
			version: 'v2.0',
		};

		let callCount = 0;
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			callCount++;
			if (callCount === 1) {
				// First org returns v1 and v2
				return [agentV1, agentV2];
			} else {
				// Second org also returns both versions
				return [agentV1, agentV2];
			}
		};

		mockOctoKitService.getCustomAgentDetails = async (owner: string, repo: string, agentName: string, version?: string) => {
			if (version === 'v1.0') {
				return { ...agentV1, prompt: 'Version 1 prompt' };
			} else if (version === 'v2.0') {
				return { ...agentV2, prompt: 'Version 2 prompt' };
			}
			return undefined;
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Different versions are deduplicated, only the first one is kept
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, 'versioned_agent');
	});

	test('does not deduplicate org-specific agents with same name from different orgs', async () => {
		const provider = createProvider();

		mockOctoKitService.setUserOrganizations(['orgA', 'orgB']);

		// Create agents with same name but from different org repos (not enterprise)
		const orgAAgent: CustomAgentListItem = {
			name: 'org_agent',
			repo_owner_id: 1,
			repo_owner: 'orgA',
			repo_id: 10,
			repo_name: 'orgA_repo',
			display_name: 'Org A Agent',
			description: 'Agent specific to org A',
			tools: [],
			version: 'v1.0',
		};

		const orgBAgent: CustomAgentListItem = {
			name: 'org_agent',
			repo_owner_id: 2,
			repo_owner: 'orgB',
			repo_id: 20,
			repo_name: 'orgB_repo',
			display_name: 'Org B Agent',
			description: 'Agent specific to org B',
			tools: [],
			version: 'v1.0',
		};

		let callCount = 0;
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			callCount++;
			if (callCount === 1) {
				return [orgAAgent];
			} else {
				return [orgBAgent];
			}
		};

		mockOctoKitService.getCustomAgentDetails = async (owner: string, repo: string, agentName: string, version?: string) => {
			if (owner === 'orgA') {
				return { ...orgAAgent, prompt: 'Org A prompt' };
			} else if (owner === 'orgB') {
				return { ...orgBAgent, prompt: 'Org B prompt' };
			}
			return undefined;
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Should have 2 agents since they're from different repos (not duplicates)
		assert.equal(agents.length, 2);
		assert.equal(agents[0].name, 'org_agent');
		assert.equal(agents[1].name, 'org_agent');
	});

	test('deduplicates enterprise agents even when API returns them in different order', async () => {
		const provider = createProvider();

		mockOctoKitService.setUserOrganizations(['orgA', 'orgB', 'orgC']);

		const enterpriseAgent1: CustomAgentListItem = {
			name: 'enterprise_agent1',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Enterprise Agent 1',
			description: 'First enterprise agent',
			tools: [],
			version: 'v1.0',
		};

		const enterpriseAgent2: CustomAgentListItem = {
			name: 'enterprise_agent2',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Enterprise Agent 2',
			description: 'Second enterprise agent',
			tools: [],
			version: 'v1.0',
		};

		let callCount = 0;
		mockOctoKitService.getCustomAgents = async (owner: string, repo: string) => {
			callCount++;
			// Return agents in different orders for different orgs
			if (callCount === 1) {
				return [enterpriseAgent1, enterpriseAgent2];
			} else if (callCount === 2) {
				return [enterpriseAgent2, enterpriseAgent1]; // Reversed order
			} else {
				return [enterpriseAgent1, enterpriseAgent2];
			}
		};

		mockOctoKitService.getCustomAgentDetails = async (owner: string, repo: string, agentName: string, version?: string) => {
			if (agentName === 'enterprise_agent1') {
				return { ...enterpriseAgent1, prompt: 'Prompt 1' };
			} else if (agentName === 'enterprise_agent2') {
				return { ...enterpriseAgent2, prompt: 'Prompt 2' };
			}
			return undefined;
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Should have exactly 2 agents, not 6 (2 agents x 3 orgs)
		assert.equal(agents.length, 2);

		// Verify both agent names are present
		const agentNames = agents.map(a => a.name).sort();
		assert.deepEqual(agentNames, ['enterprise_agent1', 'enterprise_agent2']);
	});

	test('deduplication key does not include version so different versions are deduplicated', async () => {
		const provider = createProvider();

		mockOctoKitService.setUserOrganizations(['orgA']);

		// Same agent with two different versions
		const agentV1: CustomAgentListItem = {
			name: 'multi_version_agent',
			repo_owner_id: 999,
			repo_owner: 'enterprise_org',
			repo_id: 123,
			repo_name: 'enterprise_repo',
			display_name: 'Multi Version Agent',
			description: 'Agent with multiple versions',
			tools: [],
			version: 'v1.0',
		};

		const agentV2: CustomAgentListItem = {
			...agentV1,
			version: 'v2.0',
		};

		mockOctoKitService.getCustomAgents = async () => {
			return [agentV1, agentV2];
		};

		mockOctoKitService.getCustomAgentDetails = async (owner: string, repo: string, agentName: string, version?: string) => {
			if (version === 'v1.0') {
				return { ...agentV1, prompt: 'Prompt for v1' };
			} else if (version === 'v2.0') {
				return { ...agentV2, prompt: 'Prompt for v2' };
			}
			return undefined;
		};

		await provider.provideCustomAgents({}, {} as any);
		await new Promise(resolve => setTimeout(resolve, 100));

		const agents = await provider.provideCustomAgents({}, {} as any);

		// Different versions are deduplicated, only the first one is kept
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, 'multi_version_agent');
	});
});
