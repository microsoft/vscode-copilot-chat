/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem } from '../../../platform/github/common/githubAPI';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';
import { getRepoId } from '../vscode/copilotCodingAgentUtils';
import { toPRContentUri } from './prContentProvider';

export const IPullRequestFileChangesService = createServiceIdentifier<IPullRequestFileChangesService>('IPullRequestFileChangesService');

export interface IPullRequestFileChangesService {
	readonly _serviceBrand: undefined;
	getFileChangesMultiDiffPart(pullRequest: PullRequestSearchItem): Promise<vscode.ChatResponseMultiDiffPart | undefined>;
}

export class PullRequestFileChangesService implements IPullRequestFileChangesService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IGitService private readonly _gitService: IGitService,
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
	) { }

	private isPullRequestExtensionInstalled(): boolean {
		return vscode.extensions
			.getExtension('GitHub.vscode-pull-request-github') !== undefined;
	}

	async getFileChangesMultiDiffPart(pullRequest: PullRequestSearchItem): Promise<vscode.ChatResponseMultiDiffPart | undefined> {
		try {
			this.logService.trace(`Getting file changes for PR #${pullRequest.number}`);
			const repoId = await getRepoId(this._gitService);
			if (!repoId) {
				this.logService.warn('No repo ID available for fetching PR file changes');
				return undefined;
			}

			this.logService.trace(`Fetching PR files from ${repoId.org}/${repoId.repo} for PR #${pullRequest.number}`);
			const files = await this._octoKitService.getPullRequestFiles(repoId.org, repoId.repo, pullRequest.number);
			this.logService.trace(`Got ${files?.length || 0} files from API`);

			if (!files || files.length === 0) {
				this.logService.trace('No file changes found for pull request');
				return undefined;
			}

			// Check if we have base and head commit SHAs
			if (!pullRequest.baseRefOid || !pullRequest.headRefOid) {
				this.logService.warn('PR missing base or head commit SHA, cannot create diff URIs');
				return undefined;
			}

			const diffEntries: vscode.ChatResponseDiffEntry[] = [];

			for (const file of files) {
				// Always use remote URIs to ensure we show the exact PR content
				// Local files may be on different branches or have different changes
				this.logService.trace(`Creating remote URIs for ${file.filename}`);

				const originalUri = toPRContentUri(
					file.previous_filename || file.filename,
					{
						owner: repoId.org,
						repo: repoId.repo,
						prNumber: pullRequest.number,
						commitSha: pullRequest.baseRefOid,
						isBase: true,
						previousFileName: file.previous_filename
					}
				);

				const modifiedUri = toPRContentUri(
					file.filename,
					{
						owner: repoId.org,
						repo: repoId.repo,
						prNumber: pullRequest.number,
						commitSha: pullRequest.headRefOid,
						isBase: false
					}
				);

				this.logService.trace(`DiffEntry -> original='${originalUri.toString()}' modified='${modifiedUri.toString()}' (+${file.additions} -${file.deletions})`);
				diffEntries.push({
					originalUri,
					modifiedUri,
					goToFileUri: modifiedUri,
					added: file.additions,
					removed: file.deletions,
				});
			}

			const title = `Changes in Pull Request #${pullRequest.number}`;
			return new vscode.ChatResponseMultiDiffPart(diffEntries, title, !this.isPullRequestExtensionInstalled());
		} catch (error) {
			this.logService.error(`Failed to get file changes multi diff part: ${error}`);
			return undefined;
		}
	}
}
