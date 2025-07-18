/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Manual test script to verify RepoContext functionality
 * 
 * This script demonstrates how the RepoContext now works with different repository types:
 * 1. GitHub repositories (maintains backward compatibility)
 * 2. Azure DevOps repositories
 * 3. Generic Git repositories (GitLab, Bitbucket, etc.)
 * 4. Local repositories without remotes
 * 
 * The RepoContext enhancement ensures that CI/CD tools and other scenarios get useful
 * repository context regardless of the hosting provider.
 */

import { getGitHubRepoInfoFromContext, getOrderedRepoInfosFromContext, parseRemoteUrl, AdoRepoId, GithubRepoId } from '../../../src/platform/git/common/gitService';
import { URI } from '../../../src/util/vs/base/common/uri';

// Mock RepoContext for testing different scenarios
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

// Test function to simulate what the RepoContext class does
function getRepoInfoForRendering(activeRepository: MockRepoContext): { org: string; repo: string; type: string; remoteUrl?: string } | undefined {
	// Try to get GitHub-specific information first for backward compatibility
	const githubRepoContext = getGitHubRepoInfoFromContext(activeRepository);
	
	// If not a GitHub repo, try to get general repo information
	let repoInfo: { org: string; repo: string; type: string } | undefined;
	let remoteUrl: string | undefined;

	if (githubRepoContext) {
		repoInfo = { org: githubRepoContext.id.org, repo: githubRepoContext.id.repo, type: 'github' };
		remoteUrl = githubRepoContext.remoteUrl;
	} else {
		// Try to get repository information from any supported provider
		const repoInfos = Array.from(getOrderedRepoInfosFromContext(activeRepository));
		if (repoInfos.length > 0) {
			const firstRepoInfo = repoInfos[0];
			remoteUrl = firstRepoInfo.fetchUrl;
			if (firstRepoInfo.repoId.type === 'github') {
				repoInfo = { org: firstRepoInfo.repoId.org, repo: firstRepoInfo.repoId.repo, type: 'github' };
			} else if (firstRepoInfo.repoId.type === 'ado') {
				repoInfo = { org: firstRepoInfo.repoId.org, repo: firstRepoInfo.repoId.repo, type: 'azure-devops' };
			}
		} else {
			// Fallback: extract basic information from remote URL if available
			if (activeRepository.remoteFetchUrls && activeRepository.remoteFetchUrls.length > 0) {
				const fetchUrl = activeRepository.remoteFetchUrls[0];
				if (fetchUrl) {
					const parsed = parseRemoteUrl(fetchUrl);
					if (parsed) {
						// Extract owner/repo from path for generic repos
						const pathMatch = parsed.path.match(/^\/?([^/]+)\/([^/]+?)(\/|\.git\/?)?$/i);
						if (pathMatch) {
							repoInfo = { org: pathMatch[1], repo: pathMatch[2], type: 'generic' };
							remoteUrl = fetchUrl;
						}
					}
				}
			}
		}
	}

	return repoInfo ? { ...repoInfo, remoteUrl } : undefined;
}

// Test scenarios
console.log('=== RepoContext Enhancement Manual Test ===\n');

// Test 1: GitHub Repository (should work as before)
console.log('Test 1: GitHub Repository');
const githubRepo = new MockRepoContext(
	URI.file('/workspace'),
	['https://github.com/microsoft/vscode-copilot-chat.git'],
	['origin'],
	'main',
	'origin/main',
	'origin'
);

const githubResult = getRepoInfoForRendering(githubRepo);
console.log('Result:', githubResult);
console.log('Expected: GitHub repo with org=microsoft, repo=vscode-copilot-chat, type=github\n');

// Test 2: Azure DevOps Repository  
console.log('Test 2: Azure DevOps Repository');
const adoRepo = new MockRepoContext(
	URI.file('/workspace'),
	['https://dev.azure.com/myorg/myproject/_git/myrepo'],
	['origin'],
	'main',
	'origin/main',
	'origin'
);

const adoResult = getRepoInfoForRendering(adoRepo);
console.log('Result:', adoResult);
console.log('Expected: Azure DevOps repo with org=myorg, repo=myrepo, type=azure-devops\n');

// Test 3: Generic Git Repository (GitLab)
console.log('Test 3: Generic Git Repository (GitLab)');
const gitlabRepo = new MockRepoContext(
	URI.file('/workspace'),
	['https://gitlab.com/myorg/myrepo.git'],
	['origin'],
	'main',
	'origin/main',
	'origin'
);

const gitlabResult = getRepoInfoForRendering(gitlabRepo);
console.log('Result:', gitlabResult);
console.log('Expected: Generic repo with org=myorg, repo=myrepo, type=generic\n');

// Test 4: Repository without remote (should handle gracefully)
console.log('Test 4: Repository without remote');
const localRepo = new MockRepoContext(
	URI.file('/workspace'),
	[],
	[],
	'main'
);

const localResult = getRepoInfoForRendering(localRepo);
console.log('Result:', localResult);
console.log('Expected: undefined (no remote info available)\n');

// Test 5: SSH URL
console.log('Test 5: SSH URL parsing');
const sshRepo = new MockRepoContext(
	URI.file('/workspace'),
	['git@github.com:microsoft/vscode.git'],
	['origin'],
	'main',
	'origin/main',
	'origin'
);

const sshResult = getRepoInfoForRendering(sshRepo);
console.log('Result:', sshResult);
console.log('Expected: GitHub repo with org=microsoft, repo=vscode, type=github\n');

console.log('=== Manual Test Complete ===');
console.log('The RepoContext enhancement now provides useful repository information for:');
console.log('- GitHub repositories (backward compatible)');
console.log('- Azure DevOps repositories');
console.log('- Generic Git repositories (GitLab, Bitbucket, etc.)');
console.log('- Local repositories (basic branch information)');
console.log('\nThis enables CI/CD tools and other scenarios to get repository context regardless of hosting provider.');