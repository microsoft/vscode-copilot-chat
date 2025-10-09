/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotTokenStore } from '../../../platform/authentication/common/copilotTokenStore';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitDiffService } from '../../../platform/git/common/gitDiffService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService, multiplexProperties, wouldMultiplexTelemetryPropertyBeTruncated } from '../../../platform/telemetry/common/telemetry';

// EVENT: repoInfo
type RepoInfoTelemetryProperties = {
	remoteUrl: string | undefined;
	headCommitHash: string | undefined;
	diffsJSON: string | undefined;
	result: 'success' | 'filesChanged' | 'diffTooLarge';
};

type RepoInfoInternalTelemetryProperties = RepoInfoTelemetryProperties & {
	location: 'begin' | 'end';
	telemetryMessageId: string;
};

/*
* Handles sending internal only telemetry about the current git repository
*/
export class RepoInfoTelemetry {
	private _beginTelemetrySent = false;
	private _beginTelemetryPromise: Promise<void> | undefined;

	constructor(
		private readonly _telemetryMessageId: string,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IGitService private readonly _gitService: IGitService,
		@IGitDiffService private readonly _gitDiffService: IGitDiffService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@ICopilotTokenStore private readonly _copilotTokenStore: ICopilotTokenStore,
		@ILogService private readonly _logService: ILogService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
	) { }

	/*
	* Sends the begin event telemetry, make sure to only send one time, as multiple PanelChatTelemetry instances
	* are created per user request.
	*/
	public async sendBeginTelemetryIfNeeded(): Promise<void> {
		if (this._beginTelemetrySent) {
			// Already sent or in progress
			return this._beginTelemetryPromise;
		}

		try {
			this._beginTelemetrySent = true;
			this._beginTelemetryPromise = this._sendRepoInfoTelemetry('begin');
			await this._beginTelemetryPromise;
		} catch (error) {
			this._logService.warn(`Failed to send begin repo info telemetry ${error}`);
		}
	}

	/*
	* Sends the end event telemetry
	*/
	public async sendEndTelemetry(): Promise<void> {
		await this._beginTelemetryPromise;

		try {
			await this._sendRepoInfoTelemetry('end');
		} catch (error) {
			this._logService.warn(`Failed to send end repo info telemetry ${error}`);
		}
	}

	private async _sendRepoInfoTelemetry(location: 'begin' | 'end'): Promise<void> {
		if (this._copilotTokenStore.copilotToken?.isInternal !== true) {
			return;
		}

		const gitInfo = await this._getRepoInfoTelemetry();
		if (!gitInfo) {
			return;
		}

		// Multiplex properties will split up the large properties (diffsJSON) into multiple properties
		// that we can combine later.
		const properties = multiplexProperties({
			...gitInfo,
			location,
			telemetryMessageId: this._telemetryMessageId
		} as RepoInfoInternalTelemetryProperties);

		this._telemetryService.sendInternalMSFTTelemetryEvent('request.repoInfo', properties);
	}

	private async _getRepoInfoTelemetry(): Promise<RepoInfoTelemetryProperties | undefined> {
		const repoContext = this._gitService.activeRepository.get();

		if (!repoContext || !repoContext.changes) {
			return;
		}

		const githubInfo = getGitHubRepoInfoFromContext(repoContext);
		if (!githubInfo) {
			return;
		}

		// Get the upstream commit from the repository
		const gitAPI = this._gitExtensionService.getExtensionApi();
		const repository = gitAPI?.getRepository(repoContext.rootUri);
		const upstreamCommit = repository?.state.HEAD?.upstream?.commit;
		if (!upstreamCommit) {
			return;
		}

		// Before we calculate our async diffs, sign up for file system change events
		// Any changes during the async operations will invalidate our diff data and we send it
		// as a failure without a diffs
		const watcher = this._fileSystemService.createFileSystemWatcher('**/*');
		let filesChanged = false;
		const createDisposable = watcher.onDidCreate(() => filesChanged = true);
		const changeDisposable = watcher.onDidChange(() => filesChanged = true);
		const deleteDisposable = watcher.onDidDelete(() => filesChanged = true);

		try {
			const changes = await this._gitService.diffWith(repoContext.rootUri, '@{upstream}');
			if (!changes || changes.length === 0) {
				return;
			}

			// Check if files changed during the git diff operation
			if (filesChanged) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'filesChanged',
				};
			}

			const diffs = (await this._gitDiffService.getChangeDiffs(repoContext.rootUri, changes)).map(diff => {
				return {
					uri: diff.uri.toString(),
					originalUri: diff.originalUri.toString(),
					renameUri: diff.renameUri?.toString(),
					status: diff.status,
					diff: diff.diff,
				};
			});

			// Check if files changed during the individual file diffs
			if (filesChanged) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'filesChanged',
				};
			}

			const diffsJSON = diffs.length > 0 ? JSON.stringify(diffs) : undefined;

			// Check if the diff is too big and notify that
			if (wouldMultiplexTelemetryPropertyBeTruncated(diffsJSON)) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'diffTooLarge',
				};
			}

			// Check if files changed before we send the telemetry
			if (filesChanged) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'filesChanged',
				};
			}

			return {
				remoteUrl: githubInfo.remoteUrl,
				headCommitHash: upstreamCommit,
				diffsJSON,
				result: 'success',
			};
		} finally {
			createDisposable.dispose();
			changeDisposable.dispose();
			deleteDisposable.dispose();
			watcher.dispose();
		}
	}
}