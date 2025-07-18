/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Documentation for the RepoContext Enhancement
 * 
 * This document explains the changes made to fix VSCode issue #256753 and how they improve
 * the Copilot Chat experience for users working with non-GitHub repositories.
 */

## Problem Statement

Previously, the RepoContext component in Copilot Chat only worked with GitHub repositories. 
When users had repositories hosted on other platforms (Azure DevOps, GitLab, Bitbucket, etc.) 
or local repositories, the RepoContext would return empty and provide no useful repository 
information to the AI assistant.

This limited the usefulness of Copilot Chat for:
- CI/CD tools working with non-GitHub repositories
- Enterprise users with Azure DevOps repositories
- Open source projects hosted on GitLab
- Local development workflows

## Solution Overview

The RepoContext class has been enhanced to work with any Git repository by:

1. **Maintaining backward compatibility** - GitHub repositories continue to work exactly as before
2. **Adding Azure DevOps support** - Full integration with Azure DevOps repositories
3. **Adding generic Git support** - Basic information extraction from any Git repository
4. **Graceful fallback** - Provides basic Git context even when remote information is unavailable

## Implementation Details

### Before (GitHub only)
```typescript
const repoContext = activeRepository && getGitHubRepoInfoFromContext(activeRepository);
if (!repoContext || !activeRepository) {
    return; // No context provided for non-GitHub repos
}
```

### After (All repository types)
```typescript
const githubRepoContext = getGitHubRepoInfoFromContext(activeRepository);
let repoInfo;
let remoteUrl;

if (githubRepoContext) {
    // GitHub repository - use existing logic
    repoInfo = { org: githubRepoContext.id.org, repo: githubRepoContext.id.repo, type: 'github' };
    remoteUrl = githubRepoContext.remoteUrl;
} else {
    // Try Azure DevOps and other supported providers
    const repoInfos = Array.from(getOrderedRepoInfosFromContext(activeRepository));
    if (repoInfos.length > 0) {
        const firstRepoInfo = repoInfos[0];
        if (firstRepoInfo.repoId.type === 'ado') {
            repoInfo = { org: firstRepoInfo.repoId.org, repo: firstRepoInfo.repoId.repo, type: 'azure-devops' };
        }
    } else {
        // Fallback: extract basic info from any Git repository
        const fetchUrl = activeRepository.remoteFetchUrls?.[0];
        if (fetchUrl) {
            const parsed = parseRemoteUrl(fetchUrl);
            const pathMatch = parsed?.path.match(/^\/?([^/]+)\/([^/]+?)(\/|\.git\/?)?$/i);
            if (pathMatch) {
                repoInfo = { org: pathMatch[1], repo: pathMatch[2], type: 'generic' };
            }
        }
    }
}

// Always provide some context, even if just basic Git info
if (!repoInfo) {
    return <Tag name='repoContext'>
        Current branch: {activeRepository.headBranchName}<br />
        {activeRepository.upstreamBranchName ? <>Upstream branch: {activeRepository.upstreamBranchName}<br /></> : ''}
    </Tag>;
}
```

## Enhanced Output

The RepoContext now provides richer information including:

### GitHub Repositories
```
Repository name: vscode-copilot-chat
Owner: microsoft
Repository type: github
Current branch: main
Default branch: main
Remote URL: https://github.com/microsoft/vscode-copilot-chat.git
```

### Azure DevOps Repositories
```
Repository name: myrepo
Owner: myorg
Repository type: azure-devops
Current branch: main
Upstream branch: origin/main
Remote URL: https://dev.azure.com/myorg/myproject/_git/myrepo
```

### Generic Git Repositories (GitLab, Bitbucket, etc.)
```
Repository name: myrepo
Owner: myorg
Repository type: generic
Current branch: main
Upstream branch: origin/main
Remote URL: https://gitlab.com/myorg/myrepo.git
```

### Local Repositories (no remote)
```
Current branch: main
Upstream branch: origin/main
Upstream remote: origin
```

## Benefits

1. **CI/CD Integration**: CI/CD tools can now get repository context regardless of hosting provider
2. **Enterprise Support**: Full support for Azure DevOps repositories commonly used in enterprises
3. **Open Source Flexibility**: Works with GitLab, Bitbucket, and other Git hosting platforms
4. **Local Development**: Provides useful context even for local repositories
5. **Backward Compatibility**: No breaking changes for existing GitHub users

## Testing

The implementation includes comprehensive tests:

- Unit tests for core functionality
- Integration tests for different repository types
- Manual verification scripts
- Real-world scenario testing

## Usage Examples

### For CI/CD Tools
```typescript
// The RepoContext now provides repository information for any Git repository
// This enables CI/CD tools to get context about the current repository
// regardless of whether it's hosted on GitHub, Azure DevOps, GitLab, etc.
```

### For Enterprise Users
```typescript
// Azure DevOps users now get full repository context
// including organization, project, and repository information
```

### For Open Source Projects
```typescript
// GitLab, Bitbucket, and other Git hosting platforms
// now provide basic repository context to improve AI responses
```

This enhancement makes Copilot Chat more useful and accessible to users working with diverse 
repository hosting solutions, addressing the core issue raised in VSCode #256753.