/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PromptsType, SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { IOctoKitService, SkillListOptions } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IGitHubOrgChatResourcesService } from './githubOrgChatResourcesService';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class GitHubOrgSkillProvider extends Disposable implements vscode.ChatSkillProvider {
	private readonly _onDidChangeSkills = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeSkills = this._onDidChangeSkills.event;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitHubOrgChatResourcesService private readonly githubOrgChatResourcesService: IGitHubOrgChatResourcesService,
	) {
		super();

		this._register(this.githubOrgChatResourcesService.startPolling(REFRESH_INTERVAL_MS, this.pollSkills.bind(this)));
	}

	async provideSkills(_context: unknown, token: vscode.CancellationToken): Promise<vscode.ChatResource[]> {
		try {
			const orgId = await this.githubOrgChatResourcesService.getPreferredOrganizationName();
			if (!orgId) {
				this.logService.trace('[GitHubOrgSkillProvider] No organization available for providing skills');
				return [];
			}

			if (token.isCancellationRequested) {
				this.logService.trace('[GitHubOrgSkillProvider] provideSkills was cancelled');
				return [];
			}

			return await this.githubOrgChatResourcesService.listCachedFiles(PromptsType.skill, orgId);
		} catch (error) {
			this.logService.error(`[GitHubOrgSkillProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async pollSkills(orgId: string): Promise<void> {
		try {
			const internalOptions = { includeSources: ['org', 'enterprise'], dedupe: true } satisfies SkillListOptions;

			const repos = await this.octoKitService.getOrganizationRepositories(orgId, { createIfNone: false }, 1);
			if (repos.length === 0) {
				this.logService.trace(`[GitHubOrgSkillProvider] No repositories found for org ${orgId}`);
				return;
			}

			const repoName = repos[0];
			const [skills, existingSkills] = await Promise.all([
				this.octoKitService.getSkills(orgId, repoName, internalOptions, { createIfNone: false }),
				this.githubOrgChatResourcesService.listCachedFiles(PromptsType.skill, orgId),
			]);

			let hasChanges = existingSkills.length !== skills.length;
			const newSkillFolders = new Set<string>();
			for (const skill of skills) {
				const skillDetails = await this.octoKitService.getSkillDetails(
					skill.repo_owner,
					skill.repo_name,
					skill.name,
					skill.version,
					{ createIfNone: false },
				);

				if (skillDetails) {
					const result = await this.githubOrgChatResourcesService.writeCacheFile(
						PromptsType.skill,
						orgId,
						`${skill.name}/${SKILL_FILENAME}`,
						skillDetails.content,
						{ checkForChanges: !hasChanges },
					);
					hasChanges ||= result;
					newSkillFolders.add(skill.name);
				}
			}

			if (!hasChanges) {
				this.logService.trace('[GitHubOrgSkillProvider] No changes detected in cache');
				return;
			}

			await this.githubOrgChatResourcesService.clearCache(PromptsType.skill, orgId, newSkillFolders);
			this._onDidChangeSkills.fire();
		} catch (error) {
			this.logService.error(`[GitHubOrgSkillProvider] Error polling for skills: ${error}`);
		}
	}
}