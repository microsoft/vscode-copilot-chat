/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotTokenStore } from '../../../platform/authentication/common/copilotTokenStore';
import { IGitDiffService } from '../../../platform/git/common/gitDiffService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService, multiplexProperties } from '../../../platform/telemetry/common/telemetry';

// EVENT: repoInfo
type RepoInfoProperties = {
	remoteUrl: string | undefined;
	headCommitHash: string | undefined;
	diffsJSON: string | undefined;
};

type RepoInfoInternalTelemetryProperties = RepoInfoProperties & {
	location: 'begin' | 'end';
	result: 'success' | 'failure';
	telemetryMessageId: string;
};

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
	) { }

	public async sendBeginTelemetryIfNeeded(): Promise<void> {
		// IANHU: Remove
		console.log('repoInfoTelemetry: sendBeginTelemetryIfNeeded called');

		if (this._beginTelemetrySent) {
			// Already sent or in progress
			return this._beginTelemetryPromise;
		}

		this._beginTelemetrySent = true;
		this._beginTelemetryPromise = this._sendRepoInfoTelemetry('begin');

		return this._beginTelemetryPromise.catch((error) => {
			this._logService.warn(`Failed to send begin repo info telemetry ${error}`);
		});
	}

	public async sendEndTelemetry(): Promise<void> {
		// IANHU: Remove
		console.log('repoInfoTelemetry: sendEndTelemetry called');

		await this._beginTelemetryPromise;

		return this._sendRepoInfoTelemetry('end').catch((error) => {
			this._logService.warn(`Failed to send end repo info telemetry ${error}`);
		});
	}

	private async _sendRepoInfoTelemetry(location: 'begin' | 'end'): Promise<void> {
		// IANHU: Remove
		console.log('repoInfoTelemetry: sendRepoInfoTelemetry called', location);

		if (this._copilotTokenStore.copilotToken?.isInternal !== true) {
			return;
		}

		const gitInfo = await this._getRepoInfoTelemetry();
		if (!gitInfo) {
			return;
		}

		const properties = multiplexProperties({
			...gitInfo,
			location,
			result: 'success',
			telemetryMessageId: this._telemetryMessageId
		} as RepoInfoInternalTelemetryProperties);

		this._telemetryService.sendInternalMSFTTelemetryEvent('request.repoInfo', properties);


		// IANHU: Remove logging later
		console.log(JSON.stringify({
			name: 'request.repoInfo',
			data: {
				...gitInfo,
				location,
				telemetryMessageId: this._telemetryMessageId
			}
		}));
	}

	private async _getRepoInfoTelemetry(): Promise<RepoInfoProperties | undefined> {
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

		const changes = await this._gitService.diffWith(repoContext.rootUri, '@{upstream}');
		if (!changes || changes.length === 0) {
			return;
		}

		// Reduce to just the diff information we need
		// IANHU: We might need a couple more properties here, will revisit, but keep simple for now
		const diffs = (await this._gitDiffService.getChangeDiffs(repoContext.rootUri, changes)).map(diff => {
			return {
				uri: diff.uri.toString(),
				diff: diff.diff,
			};
		});

		return {
			remoteUrl: githubInfo.remoteUrl,
			headCommitHash: upstreamCommit,
			// IANHU: Could be super large, will try using multiplex when logging
			diffsJSON: diffs.length > 0 ? JSON.stringify(diffs) : undefined,
		};
	}
}