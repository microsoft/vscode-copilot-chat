# Coding Agent Integration

## Overview

This document describes the integration between the GitHub Copilot Chat extension and the GitHub Pull Requests extension's Coding Agent feature.

## What is the Coding Agent?

The Coding Agent is a feature where GitHub Copilot can work independently in the background to complete tasks assigned via GitHub issues or pull requests. The agent can:

- Work on assigned issues and pull requests
- Make code changes autonomously
- Submit pull requests on behalf of the user
- Complete multi-step coding tasks

## Configuration

The Coding Agent feature is controlled by settings in the GitHub Pull Requests extension (`github.vscode-pull-request-github`).

### Settings

#### `githubPullRequests.codingAgent.enabled`

**Type:** `boolean`  
**Default:** `true`

Enables the Coding Agent feature in the GitHub Pull Requests extension. When enabled, you can assign issues and pull requests to Copilot, which will work on them independently.

#### `githubPullRequests.codingAgent.uiIntegration`

**Type:** `boolean`  
**Default:** `true`

Enables UI integration for the Coding Agent. This adds UI elements in VS Code to:
- Assign issues/PRs to Copilot
- View Copilot's progress on assigned tasks
- Open agent session details
- Filter PRs by "Copilot on My Behalf"

## Usage

### Assigning Tasks to the Coding Agent

1. Open an issue or pull request in VS Code
2. Use the "Assign to Copilot" option from the issue/PR view
3. Copilot will begin working on the task in the background

### Viewing Coding Agent Progress

1. Open the Pull Requests view in VS Code
2. Use the "Copilot on My Behalf" filter to see PRs the agent is working on
3. Click on a PR to see the agent's status and progress

## Integration with Copilot Chat Extension

The Copilot Chat extension integrates with the GitHub Pull Requests extension through:

- **Title and Description Generation**: Provides AI-generated PR titles and descriptions
- **Reviewer Comments**: Supplies AI-powered code review comments
- **Repository Context**: Accesses repository information for better assistance

### Code References

- `src/extension/conversation/node/githubPullRequestProviders.ts` - Main integration class
- `src/extension/prompt/node/githubPullRequestTitleAndDescriptionGenerator.ts` - PR title/description provider
- `src/extension/review/node/githubPullRequestReviewerCommentsProvider.ts` - Review comments provider
- `src/extension/githubPullRequest.d.ts` - TypeScript definitions for the API

## Requirements

- GitHub Copilot subscription
- GitHub Pull Requests extension installed and activated
- Proper authentication with GitHub

## References

- [GitHub Copilot documentation](https://docs.github.com/en/copilot)
- [VS Code Copilot Chat extension](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)
- [GitHub Pull Requests extension](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github)
