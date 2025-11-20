/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';

export class CustomAgentsProvider implements vscode.CustomAgentsProvider {

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
	) { }

	async provideCustomAgents(
		repoOwner: string,
		repoName: string,
		options: vscode.CustomAgentQueryOptions | undefined,
		token: vscode.CancellationToken
	): Promise<vscode.CustomAgent[]> {
		try {
			this.logService.trace(`[CustomAgentsProvider] Fetching custom agents for ${repoOwner}/${repoName}`);

			// Convert VS Code API options to internal options
			const internalOptions = options ? {
				target: options.target,
				excludeInvalidConfig: options.excludeInvalidConfig,
				dedupe: options.dedupe,
				includeSources: options.includeSources ? [...options.includeSources] : undefined,
			} : undefined;

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
