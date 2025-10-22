/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem } from '../../../platform/github/common/githubAPI';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';
import { getRepoId } from '../vscode/copilotCodingAgentUtils';

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
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@ILogService private readonly logService: ILogService,
	) { }

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

			const diffEntries: vscode.ChatResponseDiffEntry[] = [];
			const git = this._gitExtensionService.getExtensionApi();
			const repo = git?.repositories[0];
			const workspaceRoot = repo?.rootUri;

			if (!workspaceRoot) {
				this.logService.warn('No workspace root found for file URIs');
				return undefined;
			}

			for (const file of files) {
				const fileUri = vscode.Uri.joinPath(workspaceRoot, file.filename);
				const originalUri = file.previous_filename
					? vscode.Uri.joinPath(workspaceRoot, file.previous_filename)
					: fileUri;

				this.logService.trace(`DiffEntry -> original='${originalUri.fsPath}' modified='${fileUri.fsPath}' (+${file.additions} -${file.deletions})`);
				diffEntries.push({
					originalUri,
					modifiedUri: fileUri,
					goToFileUri: fileUri,
					added: file.additions,
					removed: file.deletions,
				});
			}

			const title = `Changes in Pull Request #${pullRequest.number}`;
			return new vscode.ChatResponseMultiDiffPart(diffEntries, title, true /* readOnly */);
		} catch (error) {
			this.logService.error(`Failed to get file changes multi diff part: ${error}`);
			return undefined;
		}
	}
}
