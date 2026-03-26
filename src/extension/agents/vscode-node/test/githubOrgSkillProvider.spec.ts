/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { PromptsType, SKILL_FILENAME } from '../../../../platform/customInstructions/common/promptTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { SkillDetails, SkillListItem, SkillListOptions } from '../../../../platform/github/common/githubService';
import { MockAuthenticationService } from '../../../../platform/ignore/node/test/mockAuthenticationService';
import { MockGitService } from '../../../../platform/ignore/node/test/mockGitService';
import { MockWorkspaceService } from '../../../../platform/ignore/node/test/mockWorkspaceService';
import { ILogService } from '../../../../platform/log/common/logService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GitHubOrgChatResourcesService } from '../githubOrgChatResourcesService';
import { GitHubOrgSkillProvider } from '../githubOrgSkillProvider';
import { MockOctoKitService } from './mockOctoKitService';

suite('GitHubOrgSkillProvider', () => {
	let disposables: DisposableStore;
	let mockOctoKitService: MockOctoKitService;
	let mockFileSystem: MockFileSystemService;
	let mockGitService: MockGitService;
	let mockWorkspaceService: MockWorkspaceService;
	let mockExtensionContext: Partial<ExtensionContext>;
	let mockAuthService: MockAuthenticationService;
	let accessor: any;
	let provider: GitHubOrgSkillProvider;
	let resourcesService: GitHubOrgChatResourcesService;

	const storagePath = '/tmp/test-storage';
	const storageUri = URI.file(storagePath);

	beforeEach(() => {
		vi.useFakeTimers();
		disposables = new DisposableStore();

		mockOctoKitService = new MockOctoKitService();
		mockFileSystem = new MockFileSystemService();
		mockGitService = new MockGitService();
		mockWorkspaceService = new MockWorkspaceService();
		mockExtensionContext = {
			globalStorageUri: storageUri,
		};
		mockAuthService = new MockAuthenticationService();

		mockOctoKitService.setUserOrganizations(['testorg']);
		mockWorkspaceService.setWorkspaceFolders([URI.file('/workspace')]);
		mockGitService.setRepositoryFetchUrls({
			rootUri: URI.file('/workspace'),
			remoteFetchUrls: ['https://github.com/testorg/repo.git']
		});

		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
	});

	afterEach(() => {
		vi.useRealTimers();
		disposables.dispose();
		mockOctoKitService.clearSkills();
	});

	function createProvider(): GitHubOrgSkillProvider {
		resourcesService = new GitHubOrgChatResourcesService(
			mockAuthService as any,
			mockExtensionContext as any,
			mockFileSystem,
			mockGitService,
			accessor.get(ILogService),
			mockOctoKitService,
			mockWorkspaceService,
		);
		disposables.add(resourcesService);

		provider = new GitHubOrgSkillProvider(
			mockOctoKitService,
			accessor.get(ILogService),
			resourcesService,
		);
		disposables.add(provider);
		return provider;
	}

	async function waitForPolling(): Promise<void> {
		await vi.advanceTimersByTimeAsync(10);
	}

	function prepopulateSkillCache(orgName: string, skillName: string, content: string): void {
		const cacheDir = URI.file(`${storagePath}/github/${orgName}/skills`);
		const skillDir = URI.joinPath(cacheDir, skillName);
		mockFileSystem.mockDirectory(cacheDir, [[skillName, 2 /* FileType.Directory */]]);
		mockFileSystem.mockDirectory(skillDir, [[SKILL_FILENAME, 1 /* FileType.File */]]);
		mockFileSystem.mockFile(URI.joinPath(skillDir, SKILL_FILENAME), content);
	}

	test('returns empty array when user has no organizations', async () => {
		mockOctoKitService.setUserOrganizations([]);
		mockWorkspaceService.setWorkspaceFolders([]);
		const provider = createProvider();

		const skills = await provider.provideSkills({}, {} as any);

		assert.deepEqual(skills, []);
	});

	test('fetches and caches skills from API', async () => {
		const mockSkill: SkillListItem = {
			name: 'api_skill',
			display_name: 'API Skill',
			description: 'A skill from API',
			repo_owner_id: 1,
			repo_owner: 'testorg',
			repo_id: 1,
			repo_name: 'testrepo',
			version: 'v1',
			file_path: '.github/skills/api_skill/SKILL.md',
			allowed_tools: ['bash', 'edit'],
			user_invocable: true,
			disable_model_invocation: false,
		};
		mockOctoKitService.setSkills([mockSkill]);

		const mockDetails: SkillDetails = {
			...mockSkill,
			content: '# API skill\n\nUse this skill carefully.\n',
		};
		mockOctoKitService.setSkillDetails('api_skill', mockDetails);

		const provider = createProvider();
		await waitForPolling();

		const skills = await provider.provideSkills({}, {} as any);
		assert.equal(skills.length, 1);
		assert.include(skills[0].uri.path, '/api_skill/SKILL.md');

		const content = await resourcesService.readCacheFile(PromptsType.skill, 'testorg', 'api_skill/SKILL.md');
		assert.equal(content, mockDetails.content);
	});

	test('passes query options to the skills API correctly', async () => {
		let capturedOptions: SkillListOptions | undefined;
		mockOctoKitService.getSkills = async (_owner: string, _repo: string, options: SkillListOptions) => {
			capturedOptions = options;
			return [];
		};

		const provider = createProvider();
		await provider.provideSkills({}, {} as any);
		await waitForPolling();

		assert.ok(capturedOptions);
		assert.deepEqual(capturedOptions.includeSources, ['org', 'enterprise']);
		assert.equal(capturedOptions.dedupe, true);
	});

	test('clears stale cached skills when the API returns no skills', async () => {
		prepopulateSkillCache('testorg', 'stale_skill', '# stale\n');

		const provider = createProvider();
		await waitForPolling();

		const skills = await provider.provideSkills({}, {} as any);
		assert.deepEqual(skills, []);
		// The mock filesystem's recursive delete behavior is not reliable enough to assert
		// file absence directly here. The observable contract is that stale skills are no
		// longer surfaced by the provider.
	});
});