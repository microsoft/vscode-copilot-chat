/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { renderPromptElement } from '../../../src/extension/prompts/node/base/promptRenderer';
import { getGitHubRepoInfoFromContext, getOrderedRepoInfosFromContext, parseRemoteUrl } from '../../../src/platform/git/common/gitService';
import { TestingServiceCollection } from '../../../src/platform/test/node/services';
import { CancellationToken } from '../../../src/util/vs/base/common/cancellation';
import { URI } from '../../../src/util/vs/base/common/uri';
import { ssuite, stest } from '../../base/stest';

// Mock RepoContext class for testing
class MockRepoContext {
	rootUri: URI;
	headBranchName: string | undefined;
	headCommitHash: string | undefined;  
	upstreamBranchName: string | undefined;
	upstreamRemote: string | undefined;
	isRebasing: boolean = false;
	remoteFetchUrls: Array<string | undefined>;
	remotes: string[];
	changes: any;
	headBranchNameObs: any;
	headCommitHashObs: any;
	upstreamBranchNameObs: any;
	upstreamRemoteObs: any;
	isRebasingObs: any;

	constructor(
		rootUri: URI,
		remoteFetchUrls: Array<string | undefined>,
		remotes: string[],
		headBranchName?: string,
		upstreamBranchName?: string,
		upstreamRemote?: string
	) {
		this.rootUri = rootUri;
		this.remoteFetchUrls = remoteFetchUrls;
		this.remotes = remotes;
		this.headBranchName = headBranchName;
		this.upstreamBranchName = upstreamBranchName;
		this.upstreamRemote = upstreamRemote;
	}

	isIgnored(uri: URI): Promise<boolean> {
		return Promise.resolve(false);
	}
}

ssuite({ title: 'RepoContext Enhancement Integration Tests', location: 'external' }, () => {
	
	stest({ description: 'GitHub repository detection should work as before', language: 'typescript' }, async (testingServiceCollection) => {
		const mockRepo = new MockRepoContext(
			URI.file('/workspace'),
			['https://github.com/microsoft/vscode-copilot-chat.git'],
			['origin'],
			'main',
			'origin/main',
			'origin'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.ok(githubInfo, 'Should detect GitHub repository');
		assert.strictEqual(githubInfo.id.org, 'microsoft', 'Should extract correct org');
		assert.strictEqual(githubInfo.id.repo, 'vscode-copilot-chat', 'Should extract correct repo');
		assert.strictEqual(githubInfo.remoteUrl, 'https://github.com/microsoft/vscode-copilot-chat.git', 'Should have correct remote URL');
	});

	stest({ description: 'Azure DevOps repository should be detected', language: 'typescript' }, async (testingServiceCollection) => {
		const mockRepo = new MockRepoContext(
			URI.file('/workspace'),
			['https://dev.azure.com/myorg/myproject/_git/myrepo'],
			['origin'],
			'main',
			'origin/main',
			'origin'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.strictEqual(githubInfo, undefined, 'Should not detect as GitHub');

		const repoInfos = Array.from(getOrderedRepoInfosFromContext(mockRepo));
		assert.ok(repoInfos.length > 0, 'Should detect as a supported repository');
		assert.strictEqual(repoInfos[0].repoId.type, 'ado', 'Should detect as Azure DevOps');
		
		if (repoInfos[0].repoId.type === 'ado') {
			assert.strictEqual(repoInfos[0].repoId.org, 'myorg', 'Should extract correct org');
			assert.strictEqual(repoInfos[0].repoId.repo, 'myrepo', 'Should extract correct repo');
		}
	});

	stest({ description: 'Generic Git repository should be parseable', language: 'typescript' }, async (testingServiceCollection) => {
		const mockRepo = new MockRepoContext(
			URI.file('/workspace'),
			['https://gitlab.com/myorg/myrepo.git'],
			['origin'],
			'main',
			'origin/main',
			'origin'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.strictEqual(githubInfo, undefined, 'Should not detect as GitHub');

		const repoInfos = Array.from(getOrderedRepoInfosFromContext(mockRepo));
		assert.strictEqual(repoInfos.length, 0, 'Should not detect as supported provider');

		// Test parsing the URL directly
		const parsed = parseRemoteUrl('https://gitlab.com/myorg/myrepo.git');
		assert.ok(parsed, 'Should parse GitLab URL');
		assert.strictEqual(parsed.host, 'gitlab.com', 'Should extract correct host');
		assert.strictEqual(parsed.path, '/myorg/myrepo.git', 'Should extract correct path');
		
		// Test regex extraction
		const pathMatch = parsed.path.match(/^\/?([^/]+)\/([^/]+?)(\/|\.git\/?)?$/i);
		assert.ok(pathMatch, 'Should match path pattern');
		assert.strictEqual(pathMatch[1], 'myorg', 'Should extract org from path');
		assert.strictEqual(pathMatch[2], 'myrepo', 'Should extract repo from path');
	});

	stest({ description: 'Repository without remote should handle gracefully', language: 'typescript' }, async (testingServiceCollection) => {
		const mockRepo = new MockRepoContext(
			URI.file('/workspace'),
			[],
			[],
			'main'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.strictEqual(githubInfo, undefined, 'Should not detect as GitHub');

		const repoInfos = Array.from(getOrderedRepoInfosFromContext(mockRepo));
		assert.strictEqual(repoInfos.length, 0, 'Should not detect any repository info');
	});

	stest({ description: 'SSH URL should be parsed correctly', language: 'typescript' }, async (testingServiceCollection) => {
		const sshUrl = 'git@github.com:microsoft/vscode.git';
		const parsed = parseRemoteUrl(sshUrl);
		assert.ok(parsed, 'Should parse SSH URL');
		assert.strictEqual(parsed.host, 'github.com', 'Should extract correct host');
		assert.strictEqual(parsed.path, '/microsoft/vscode.git', 'Should extract correct path');
	});

	stest({ description: 'Multiple remotes should prioritize correctly', language: 'typescript' }, async (testingServiceCollection) => {
		const mockRepo = new MockRepoContext(
			URI.file('/workspace'),
			['https://github.com/fork/repo.git', 'https://github.com/microsoft/vscode.git'],
			['fork', 'upstream'],
			'main',
			'upstream/main',
			'upstream'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.ok(githubInfo, 'Should detect GitHub repository');
		// Should prioritize upstream remote due to upstreamRemote setting
		assert.strictEqual(githubInfo.id.org, 'microsoft', 'Should prioritize upstream org');
		assert.strictEqual(githubInfo.id.repo, 'vscode', 'Should prioritize upstream repo');
	});
});