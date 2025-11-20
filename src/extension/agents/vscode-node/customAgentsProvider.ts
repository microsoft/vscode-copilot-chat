/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { CustomAgentListOptions, IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { getRepoId } from '../../chatSessions/vscode/copilotCodingAgentUtils';

export class CustomAgentsProvider implements vscode.CustomAgentsProvider {

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitService private readonly gitService: IGitService,
	) { }

	async provideCustomAgents(
		options: vscode.CustomAgentQueryOptions | undefined,
		token: vscode.CancellationToken
	): Promise<vscode.CustomAgent[]> {
		try {
			// Get repository information from the active git repository
			const repoId = await getRepoId(this.gitService);
			if (!repoId) {
				this.logService.trace('[CustomAgentsProvider] No active repository found');
				return [];
			}

			const repoOwner = repoId.org;
			const repoName = repoId.repo;

			this.logService.trace(`[CustomAgentsProvider] Fetching custom agents for ${repoOwner}/${repoName}`);

			// Convert VS Code API options to internal options
			const internalOptions = options ? {
				target: options.target,
				includeSources: ['org', 'enterprise'] // don't include 'repo' to avoid redundancy
			} satisfies CustomAgentListOptions : undefined;

			const agents = await this.octoKitService.getCustomAgents(repoOwner, repoName, internalOptions);

			// Convert internal agent format to VS Code API format
			return agents.map(agent => ({
				name: agent.name,
				displayName: agent.display_name,
				description: agent.description,
				repoOwner: agent.repo_owner,
				repoName: agent.repo_name,
				version: agent.version,
				tools: agent.tools,
				argumentHint: agent.argument_hint,
				metadata: agent.metadata,
				target: agent.target,
				configError: agent.config_error,
			}));
		} catch (error) {
			this.logService.error(`[CustomAgentsProvider] Error fetching custom agents: ${error}`);
			return [];
		}
	}
}
