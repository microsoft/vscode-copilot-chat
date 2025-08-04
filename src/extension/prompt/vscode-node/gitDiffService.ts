/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, workspace } from 'vscode';
import { Diff, IGitDiffService } from '../../../platform/git/common/gitDiffService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { Change, Repository } from '../../../platform/git/vscode/git';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { isUri } from '../../../util/common/types';
import * as path from '../../../util/vs/base/common/path';
import { isEqual } from '../../../util/vs/base/common/resources';

export class GitDiffService implements IGitDiffService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@ILogService private readonly _logService: ILogService
	) { }

	private async _resolveRepository(repositoryOrUri: Repository | Uri): Promise<Repository | null | undefined> {
		if (isUri(repositoryOrUri)) {
			const extensionApi = this._gitExtensionService.getExtensionApi();
			return extensionApi?.getRepository(repositoryOrUri) ?? await extensionApi?.openRepository(repositoryOrUri) ?? extensionApi?.repositories.find((repo) => isEqual(repo.rootUri, repositoryOrUri));
		}
		return repositoryOrUri;
	}

	async getChangeDiffs(repositoryOrUri: Repository | Uri, changes: Change[]): Promise<Diff[]> {
		this._logService.debug(`[GitDiffService] Changes (before context exclusion): ${changes.length} file(s)`);

		const repository = await this._resolveRepository(repositoryOrUri);
		if (!repository) {
			this._logService.debug(`[GitDiffService] Repository not found for uri: ${repositoryOrUri.toString()}`);
			return [];
		}

		const diffs: Diff[] = [];
		for (const change of changes) {
			if (await this._ignoreService.isCopilotIgnored(change.uri)) {
				this._logService.debug(`[GitDiffService] Ignoring change due to content exclusion rule based on uri: ${change.uri.toString()}`);
				continue;
			}

			switch (change.status) {
				case 0 /* INDEX_ADDED */:
				case 1 /* INDEX_COPIED */:
				case 2 /* INDEX_DELETED */:
				case 3 /* INDEX_MODIFIED */:
				case 4 /* INDEX_RENAMED */:
					diffs.push({ originalUri: change.originalUri, renameUri: change.renameUri, status: change.status, uri: change.uri, diff: await repository.diffIndexWithHEAD(change.uri.fsPath) });
					break;
				case 7 /* UNTRACKED */:
					diffs.push({ originalUri: change.originalUri, renameUri: change.renameUri, status: change.status, uri: change.uri, diff: await this._getUntrackedChangePatch(repository, change.uri) });
					break;
				default:
					diffs.push({ originalUri: change.originalUri, renameUri: change.renameUri, status: change.status, uri: change.uri, diff: await repository.diffWithHEAD(change.uri.fsPath) });
					break;
			}
		}

		this._logService.debug(`[GitDiffService] Changes (after context exclusion): ${diffs.length} file(s)`);

		return diffs;
	}

	private async _getUntrackedChangePatch(repository: Repository, resource: Uri): Promise<string> {
		const patch: string[] = [];

		try {
			const buffer = await workspace.fs.readFile(resource);
			const relativePath = path.relative(repository.rootUri.fsPath, resource.fsPath);

			// Header
			patch.push(`diff --git a/${relativePath} b/${relativePath}`);

			// Add original/modified file paths
			patch.push('--- /dev/null', `+++ b/${relativePath}`);

			// Add range header
			patch.push(`@@ -0,0 +1,${buffer.length} @@`);

			// Add content
			patch.push(...buffer.toString().split('\n').map(line => `+${line}`));
		} catch (err) {
			console.error(err, `Failed to generate patch file for untracked file: ${resource.toString()}`);
		}

		return patch.join('\n');
	}
}
