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
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';

// Max telemetry payload size is 1MB, we add shared properties in further code and JSON structure overhead to that
// so check our diff JSON size against 900KB to be conservative with space
const MAX_DIFFS_JSON_SIZE = 900 * 1024;

// Max changes to avoid degenerate cases like mass renames
const MAX_CHANGES = 100;

// EVENT: repoInfo
type RepoInfoTelemetryResult = 'success' | 'filesChanged' | 'diffTooLarge' | 'noChanges' | 'tooManyChanges';

type RepoInfoTelemetryProperties = {
	remoteUrl: string | undefined;
	headCommitHash: string | undefined;
	diffsJSON: string | undefined;
	result: RepoInfoTelemetryResult;
};

type RepoInfoInternalTelemetryProperties = RepoInfoTelemetryProperties & {
	location: 'begin' | 'end';
	telemetryMessageId: string;
};

// Only send ending telemetry on states where we capture repo info or no changes currently
function shouldSendEndTelemetry(result: RepoInfoTelemetryResult | undefined): boolean {
	return result === 'success' || result === 'noChanges';
}

/*
* Handles sending internal only telemetry about the current git repository
*/
export class RepoInfoTelemetry {
	private _beginTelemetrySent = false;
	private _beginTelemetryPromise: Promise<RepoInfoTelemetryProperties | undefined> | undefined;
	private _beginTelemetryResult: RepoInfoTelemetryResult | undefined;

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
			await this._beginTelemetryPromise;
			return;
		}

		try {
			this._beginTelemetrySent = true;
			this._beginTelemetryPromise = this._sendRepoInfoTelemetry('begin');
			const gitInfo = await this._beginTelemetryPromise;
			this._beginTelemetryResult = gitInfo?.result;
		} catch (error) {
			this._logService.warn(`Failed to send begin repo info telemetry ${error}`);
		}
	}

	/*
	* Sends the end event telemetry
	*/
	public async sendEndTelemetry(): Promise<void> {
		await this._beginTelemetryPromise;

		// Skip end telemetry if begin wasn't successful
		if (!shouldSendEndTelemetry(this._beginTelemetryResult)) {
			return;
		}

		try {
			await this._sendRepoInfoTelemetry('end');
		} catch (error) {
			this._logService.warn(`Failed to send end repo info telemetry ${error}`);
		}
	}

	private async _sendRepoInfoTelemetry(location: 'begin' | 'end'): Promise<RepoInfoTelemetryProperties | undefined> {
		if (this._copilotTokenStore.copilotToken?.isInternal !== true) {
			return undefined;
		}

		const gitInfo = await this._getRepoInfoTelemetry();
		if (!gitInfo) {
			return undefined;
		}

		const properties: RepoInfoInternalTelemetryProperties = {
			...gitInfo,
			location,
			telemetryMessageId: this._telemetryMessageId
		};

		this._telemetryService.sendInternalMSFTTelemetryEvent('request.repoInfo', properties);

		return gitInfo;
	}

	private async _getRepoInfoTelemetry(): Promise<RepoInfoTelemetryProperties | undefined> {
		const repoContext = this._gitService.activeRepository.get();

		if (!repoContext) {
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
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'noChanges',
				};
			}

			// Check if there are too many changes (e.g., mass renames)
			if (changes.length > MAX_CHANGES) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'tooManyChanges',
				};
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

			// Check against our size limit to make sure our telemetry fits in the 1MB limit
			if (diffsJSON && Buffer.byteLength(diffsJSON, 'utf8') > MAX_DIFFS_JSON_SIZE) {
				return {
					remoteUrl: githubInfo.remoteUrl,
					headCommitHash: upstreamCommit,
					diffsJSON: undefined,
					result: 'diffTooLarge',
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