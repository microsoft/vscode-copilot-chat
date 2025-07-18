/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { getGitHubRepoInfoFromContext, getOrderedRepoInfosFromContext, parseRemoteUrl, AdoRepoId, GithubRepoId } from '../../../src/platform/git/common/gitService';

// Mock RepoContext for testing
class MockRepoContext {
	rootUri: any;
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
		remoteFetchUrls: Array<string | undefined>,
		remotes: string[],
		headBranchName?: string,
		upstreamBranchName?: string,
		upstreamRemote?: string
	) {
		this.remoteFetchUrls = remoteFetchUrls;
		this.remotes = remotes;
		this.headBranchName = headBranchName;
		this.upstreamBranchName = upstreamBranchName;
		this.upstreamRemote = upstreamRemote;
	}

	isIgnored(uri: any): Promise<boolean> {
		return Promise.resolve(false);
	}
}

suite('RepoContext Enhancement Tests', () => {
	test('GitHub repository should work as before', () => {
		const mockRepo = new MockRepoContext(
			['https://github.com/microsoft/vscode-copilot-chat.git'],
			['origin'],
			'main',
			'origin/main',
			'origin'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.ok(githubInfo, 'Should detect GitHub repository');
		assert.strictEqual(githubInfo.id.org, 'microsoft');
		assert.strictEqual(githubInfo.id.repo, 'vscode-copilot-chat');
	});

	test('Azure DevOps repository should be detected', () => {
		const mockRepo = new MockRepoContext(
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
		assert.strictEqual(repoInfos[0].repoId.type, 'ado');
		
		if (repoInfos[0].repoId.type === 'ado') {
			const adoId = repoInfos[0].repoId as AdoRepoId;
			assert.strictEqual(adoId.org, 'myorg');
			assert.strictEqual(adoId.project, 'myproject');
			assert.strictEqual(adoId.repo, 'myrepo');
		}
	});

	test('Generic Git repository should be parsed correctly', () => {
		const mockRepo = new MockRepoContext(
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
		assert.strictEqual(parsed.host, 'gitlab.com');
		assert.strictEqual(parsed.path, '/myorg/myrepo.git');
	});

	test('SSH URL should be parsed correctly', () => {
		const sshUrl = 'git@github.com:microsoft/vscode.git';
		const parsed = parseRemoteUrl(sshUrl);
		assert.ok(parsed, 'Should parse SSH URL');
		assert.strictEqual(parsed.host, 'github.com');
		assert.strictEqual(parsed.path, '/microsoft/vscode.git');
	});

	test('Repository without remote should handle gracefully', () => {
		const mockRepo = new MockRepoContext(
			[],
			[],
			'main'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.strictEqual(githubInfo, undefined, 'Should not detect as GitHub');

		const repoInfos = Array.from(getOrderedRepoInfosFromContext(mockRepo));
		assert.strictEqual(repoInfos.length, 0, 'Should not detect any repository info');
	});

	test('Multiple remotes should prioritize correctly', () => {
		const mockRepo = new MockRepoContext(
			['https://github.com/fork/repo.git', 'https://github.com/microsoft/vscode.git'],
			['fork', 'upstream'],
			'main',
			'upstream/main',
			'upstream'
		);

		const githubInfo = getGitHubRepoInfoFromContext(mockRepo);
		assert.ok(githubInfo, 'Should detect GitHub repository');
		// Should prioritize upstream remote due to upstreamRemote setting
		assert.strictEqual(githubInfo.id.org, 'microsoft');
		assert.strictEqual(githubInfo.id.repo, 'vscode');
	});
});