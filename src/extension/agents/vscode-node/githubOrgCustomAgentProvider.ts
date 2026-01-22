/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import YAML from 'yaml';
import { AGENT_FILE_EXTENSION, PromptsType } from '../../../platform/customInstructions/common/promptTypes';
import { CustomAgentDetails, CustomAgentListOptions, IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IGitHubOrgChatResourcesService } from './githubOrgChatResourcesService';

/**
 * Polling interval for refreshing custom agents from GitHub (5 minutes).
 * We poll a bit less frequently as we need to loop and fetch full agent details including prompt content.
 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class GitHubOrgCustomAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitHubOrgChatResourcesService private readonly githubOrgChatResourcesService: IGitHubOrgChatResourcesService,
	) {
		super();

		// Set up polling with provider-specific interval
		this._register(this.githubOrgChatResourcesService.startPolling(REFRESH_INTERVAL_MS, this.pollAgents.bind(this)));
	}

	async provideCustomAgents(_context: unknown, token: vscode.CancellationToken): Promise<vscode.ChatResource[]> {
		try {
			const orgId = await this.githubOrgChatResourcesService.getPreferredOrganizationName();
			if (!orgId) {
				this.logService.trace('[GitHubOrgCustomAgentProvider] No organization available for providing agents');
				return [];
			}

			if (token.isCancellationRequested) {
				this.logService.trace('[GitHubOrgCustomAgentProvider] provideCustomAgents was cancelled');
				return [];
			}

			return await this.githubOrgChatResourcesService.listCachedFiles(PromptsType.agent, orgId);
		} catch (error) {
			this.logService.error(`[GitHubOrgCustomAgentProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async pollAgents(orgId: string): Promise<void> {
		try {
			// Convert VS Code API options to internal options
			// It's okay to include enterprise agents here which may take from other orgs, as we only retrieve per org
			const internalOptions = { includeSources: ['org', 'enterprise'] } satisfies CustomAgentListOptions;

			// Note: we need to fetch an arbitrary visible/accessible repository, in case user does not have access to .github-private
			const repos = await this.octoKitService.getOrganizationRepositories(orgId, { createIfNone: false });
			if (repos.length === 0) {
				this.logService.trace(`[GitHubOrgCustomAgentProvider] No repositories found for org ${orgId}`);
				return;
			}

			// Fetch custom agents from GitHub and compare with existing agents in cache
			const repoName = repos[0];
			const [agents, existingAgents] = await Promise.all([
				this.octoKitService.getCustomAgents(orgId, repoName, internalOptions, { createIfNone: false }),
				this.githubOrgChatResourcesService.listCachedFiles(PromptsType.agent, orgId)
			]);

			let hasChanges: boolean = existingAgents.length !== agents.length;
			const newFiles = new Set<string>();
			for (const agent of agents) {
				// Fetch full agent details including prompt content
				const agentDetails = await this.octoKitService.getCustomAgentDetails(
					agent.repo_owner,
					agent.repo_name,
					agent.name,
					agent.version,
					{ createIfNone: false },
				);

				// Generate agent markdown file content
				if (agentDetails) {
					const filename = `${agent.name}${AGENT_FILE_EXTENSION}`;
					const content = this.generateAgentMarkdown(agentDetails);
					const result = await this.githubOrgChatResourcesService.writeCacheFile(
						PromptsType.agent,
						orgId,
						filename,
						content,
						{ checkForChanges: !hasChanges }
					);
					hasChanges ||= result;
					newFiles.add(filename);
				}
			}

			if (!hasChanges) {
				this.logService.trace('[GitHubOrgCustomAgentProvider] No changes detected in cache');
				return;
			}

			// Remove all cached agents that are no longer present
			await this.githubOrgChatResourcesService.clearCache(PromptsType.agent, orgId, newFiles);

			// Fire event to notify consumers that agents have changed
			this._onDidChangeCustomAgents.fire();
		} catch (error) {
			this.logService.error(`[GitHubOrgCustomAgentProvider] Error polling for agents: ${error}`);
		}
	}

	private escapeYamlString(value: string): string {
		// Escape backslashes first, then quotes and hash symbols
		return value
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/'/g, '\\\'')
			.replace(/#/g, '\\#');
	}

	private generateAgentMarkdown(agent: CustomAgentDetails): string {
		const frontmatterObj: Record<string, unknown> = {};

		if (agent.display_name) {
			frontmatterObj.name = this.escapeYamlString(agent.display_name);
		}
		if (agent.description) {
			// Escape newlines in description to keep it on a single line
			frontmatterObj.description = agent.description.replace(
				/\n/g,
				'\\n',
			);
		}
		if (agent.tools && agent.tools.length > 0 && agent.tools[0] !== '*') {
			frontmatterObj.tools = agent.tools;
		}
		if (agent.argument_hint) {
			frontmatterObj['argument-hint'] = agent.argument_hint;
		}
		if (agent.target) {
			frontmatterObj.target = agent.target;
		}
		if (agent.model) {
			frontmatterObj.model = agent.model;
		}
		if (agent.infer) {
			frontmatterObj.infer = agent.infer;
		}

		const frontmatter = YAML.stringify(frontmatterObj, {
			lineWidth: 0,
		}).trim();
		const body = agent.prompt ?? '';

		return `---\n${frontmatter}\n---\n${body}\n`;
	}
}
