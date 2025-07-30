/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as l10n from '@vscode/l10n';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { CancelablePromise, createCancelablePromise, DeferredPromise, IntervalTimer, raceCancellationError, raceTimeout } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { Schemas } from '../../../util/vs/base/common/network';
import { URI } from '../../../util/vs/base/common/uri';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IGitExtensionService } from '../../git/common/gitExtensionService';
import { AdoRepoId, getGithubRepoIdFromFetchUrl, getOrderedRemoteUrlsFromContext, getOrderedRepoInfosFromContext, GithubRepoId, IGitService, parseRemoteUrl, RepoContext, ResolvedRepoRemoteInfo } from '../../git/common/gitService';
import { Change } from '../../git/vscode/git';
import { LogExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { isGitHubRemoteRepository } from '../../remoteRepositories/common/utils';
import { ISimulationTestContext } from '../../simulationTestContext/common/simulationTestContext';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { IAdoCodeSearchService } from '../common/adoCodeSearchService';
import { IGithubCodeSearchService } from '../common/githubCodeSearchService';
import { RemoteCodeSearchIndexState, RemoteCodeSearchIndexStatus } from '../common/remoteCodeSearch';
import { ICodeSearchAuthenticationService } from './codeSearchRepoAuth';

export enum RepoStatus {
	/** We could not resolve this repo */
	NotResolvable = 'NotResolvable',

	Initializing = 'Initializing',

	/** We are checking the status of the remote index. */
	CheckingStatus = 'CheckingStatus',

	/** The remote index is indexable but not built yet */
	NotYetIndexed = 'NotYetIndexed',

	/** The remote index is not indexed and we cannot trigger indexing for it */
	NotIndexable = 'NotIndexable',

	/**
	 * We failed to check the remote index status.
	 *
	 * This has a number of possible causes:
	 *
	 * - The repo doesn't exist
	 * - The user cannot access the repo (most services won't differentiate with it not existing). If we know
	 * 		for sure that the user cannot access the repo, we will instead use {@linkcode NotAuthorized}.
	 * - The status endpoint returned an error.
	 */
	CouldNotCheckIndexStatus = 'CouldNotCheckIndexStatus',

	/**
	 * The user is not authorized to access the remote index.
	 *
	 * This is a special case of {@linkcode CouldNotCheckIndexStatus} that is shown when we know the user is not authorized.
	 */
	NotAuthorized = 'NotAuthorized',

	/** The remote index is being build but is not ready for use  */
	BuildingIndex = 'BuildingIndex',

	/** The remote index is ready and usable */
	Ready = 'Ready',
}

export interface RepoInfo {
	readonly rootUri: URI;
}


export interface ResolvedRepoEntry {
	readonly status: RepoStatus.NotYetIndexed | RepoStatus.NotIndexable | RepoStatus.BuildingIndex | RepoStatus.CouldNotCheckIndexStatus | RepoStatus.NotAuthorized;
	readonly repo: RepoInfo;
	readonly remoteInfo: ResolvedRepoRemoteInfo;
}

export interface IndexedRepoEntry {
	readonly status: RepoStatus.Ready;
	readonly repo: RepoInfo;
	readonly remoteInfo: ResolvedRepoRemoteInfo;
	readonly indexedCommit: string | undefined;
}

interface InitTask {
	readonly p: Promise<void>;
	readonly cts: CancellationTokenSource;
}

export type RepoEntry =
	{
		readonly status: RepoStatus.NotResolvable;
		readonly repo: RepoInfo;
	} | {
		readonly status: RepoStatus.Initializing;
		readonly repo: RepoInfo;
		readonly initTask: InitTask;
	} | {
		readonly status: RepoStatus.CheckingStatus;
		readonly repo: RepoInfo;
		readonly remoteInfo: ResolvedRepoRemoteInfo;
		readonly initTask: InitTask;
	}
	| ResolvedRepoEntry
	| IndexedRepoEntry
	;

export type BuildIndexTriggerReason = 'auto' | 'manual';

export interface TriggerIndexingError {
	readonly id: string;
	readonly userMessage: string;
}

export namespace TriggerRemoteIndexingError {
	export const noGitRepos: TriggerIndexingError = {
		id: 'no-git-repos',
		userMessage: l10n.t("No git repos found")
	};

	export const stillResolving: TriggerIndexingError = {
		id: 'still-resolving',
		userMessage: l10n.t("Still resolving repos. Please try again shortly.")
	};

	export const noRemoteIndexableRepos: TriggerIndexingError = {
		id: 'no-remote-indexable-repos',
		userMessage: l10n.t("No remotely indexable repos found")
	};

	export const noValidAuthToken: TriggerIndexingError = {
		id: 'no-valid-auth-token',
		userMessage: l10n.t("No valid auth token")
	};

	export const alreadyIndexed: TriggerIndexingError = {
		id: 'already-indexed',
		userMessage: l10n.t("Already indexed")
	};

	export const alreadyIndexing: TriggerIndexingError = {
		id: 'already-indexing',
		userMessage: l10n.t("Already indexing")
	};

	export const couldNotCheckIndexStatus: TriggerIndexingError = {
		id: 'could-not-check-index-status',
		userMessage: l10n.t("Could not check the remote index status for this repo")
	};

	export function errorTriggeringIndexing(repoId: GithubRepoId | AdoRepoId): TriggerIndexingError {
		return {
			id: 'request-to-index-failed',
			userMessage: l10n.t`Request to index '${repoId.toString()}' failed`
		};
	}
}

export interface CodeSearchDiff {
	readonly changes: readonly Change[];
	readonly mayBeOutdated?: boolean;
}

/**
 * Ids used to identify the type of remote for telemetry purposes
 *
 * Do not change these values as they are used in telemetry.
 */
enum GitRemoteTypeForTelemetry {
	NoRemotes = 0,
	Unknown = 1,

	Github = 2,
	Ghe = 3,

	// Unsupported
	AzureDevOps = 4,
	VisualStudioDotCom = 5,
	GitLab = 6,
	BitBucket = 7,
}

const remoteHostTelemetryIdMapping = new Map<string, GitRemoteTypeForTelemetry>([
	['github.com', GitRemoteTypeForTelemetry.Github],
	['ghe.com', GitRemoteTypeForTelemetry.Ghe],

	['dev.azure.com', GitRemoteTypeForTelemetry.AzureDevOps],
	['visualstudio.com', GitRemoteTypeForTelemetry.VisualStudioDotCom],
	['gitlab.com', GitRemoteTypeForTelemetry.GitLab],
	['bitbucket.org', GitRemoteTypeForTelemetry.BitBucket],
]);

function getRemoteTypeForTelemetry(remoteHost: string): GitRemoteTypeForTelemetry {
	remoteHost = remoteHost.toLowerCase();
	for (const [key, value] of remoteHostTelemetryIdMapping) {
		if (remoteHost === key || remoteHost.endsWith('.' + key)) {
			return value;
		}
	}

	return GitRemoteTypeForTelemetry.Unknown;
}

/**
 * Tracks all repositories in the workspace that have been indexed for code search.
 */
export class CodeSearchRepoTracker extends Disposable {
	// TODO: Switch to use backoff instead of polling at fixed intervals
	private readonly _repoIndexPollingInterval = 3000; // ms
	private readonly maxPollingAttempts = 120;

	private readonly _repos = new ResourceMap<RepoEntry>();
	private readonly _repoIndexPolling = new ResourceMap<{
		readonly poll: IntervalTimer;
		readonly deferredP: DeferredPromise<void>;
		attemptNumber: number;
	}>();

	private readonly _onDidFinishInitialization = this._register(new Emitter<void>());
	public readonly onDidFinishInitialization = this._onDidFinishInitialization.event;

	private readonly _onDidAddOrUpdateRepo = this._register(new Emitter<RepoEntry>());
	public readonly onDidAddOrUpdateRepo = this._onDidAddOrUpdateRepo.event;

	private readonly _onDidRemoveRepo = this._register(new Emitter<RepoEntry>());
	public readonly onDidRemoveRepo = this._onDidRemoveRepo.event;

	private readonly _initializedGitReposP: CancelablePromise<void>;
	private readonly _initializedGitHubRemoteReposP: CancelablePromise<void>;

	private _isDisposed = false;

	constructor(
		@IAdoCodeSearchService private readonly _adoCodeSearchService: IAdoCodeSearchService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ICodeSearchAuthenticationService private readonly _codeSearchAuthService: ICodeSearchAuthenticationService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@IGithubCodeSearchService private readonly _githubCodeSearchService: IGithubCodeSearchService,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
		@ISimulationTestContext private readonly _simulationTestContext: ISimulationTestContext,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._initializedGitReposP = createCancelablePromise(async (token) => {
			this._logService.trace(`CodeSearchRepoTracker.tryInitGitRepos(): started`);

			try {
				if (!this._gitService.isInitialized) {
					this._logService.trace(`CodeSearchRepoTracker.tryInitGitRepos(): Git service not initialized. Waiting for init signal.`);
					const finishInitTimeout = 30_000;
					await raceCancellationError(raceTimeout(new Promise<void>(resolve => this._gitService.onDidFinishInitialization(() => resolve())), finishInitTimeout), token);
					if (this._isDisposed) {
						return;
					}
				}

				this._logService.trace(`CodeSearchRepoTracker.tryInitGitRepos(): Found initial repos: [${this._gitService.repositories.map(repo => repo.rootUri.toString())}].`);

				const openPromises = this._gitService.repositories.map(repo => this.openGitRepo(repo));

				this._register(this._gitService.onDidOpenRepository(repo => this.openGitRepo(repo)));
				this._register(this._gitService.onDidCloseRepository(repo => this.closeRepo(repo)));

				await raceCancellationError(Promise.allSettled(openPromises), token);
				this._logService.trace(`CodeSearchRepoTracker.tryInitGitRepos(): Complete`);
			} catch (e) {
				this._logService.error(`CodeSearchRepoTracker.tryInitGitRepos(): Error occurred during initialization: ${e}`);
			}
		});

		this._initializedGitHubRemoteReposP = createCancelablePromise(async (token) => {
			try {
				const githubRemoteRepos = this._workspaceService.getWorkspaceFolders().filter(isGitHubRemoteRepository);
				if (!githubRemoteRepos.length) {
					return;
				}

				this._logService.trace(`CodeSearchRepoTracker.initGithubRemoteRepos(): started`);

				await raceCancellationError(
					Promise.all(githubRemoteRepos.map(workspaceRoot => {
						const githubRepoIdParts = workspaceRoot.path.slice(1).split('/');
						return this.openGithubRemoteRepo(workspaceRoot, new GithubRepoId(githubRepoIdParts[0], githubRepoIdParts[1]));
					})),
					token);
				this._logService.trace(`CodeSearchRepoTracker.initGithubRemoteRepos(): complete`);
			} catch (e) {
				this._logService.error(`CodeSearchRepoTracker.initGithubRemoteRepos(): Error occurred during initialization: ${e}`);
			}
		});

		const refreshInterval = this._register(new IntervalTimer());
		refreshInterval.cancelAndSet(() => this.updateIndexedCommitForAllRepos(), 5 * 60 * 1000); // 5 minutes

		// When the authentication state changes, we need to update the state of all valid repos
		this._register(Event.any(
			this._authenticationService.onDidAuthenticationChange,
			this._authenticationService.onDidAdoAuthenticationChange,
			this._adoCodeSearchService.onDidChangeIndexState
		)(() => {
			this.updateAllRepoStatuses();
		}));
	}

	private _hasFinishedInitialization = false;
	private _initializePromise: Promise<void> | undefined;

	@LogExecTime(self => self._logService, 'CodeSearchRepoTracker.initialize')
	public async initialize() {
		this._initializePromise ??= (async () => {
			try {
				// Wait for the initial repos to be found
				// Find all initial repos
				await Promise.all([
					this._initializedGitReposP,
					this._initializedGitHubRemoteReposP
				]);

				if (this._isDisposed) {
					return;
				}

				// And make sure they have done their initial checks.
				// After this the repos may still be left polling github but we've done at least one check
				await Promise.all(Array.from(this._repos.values(), async repo => {
					if (repo.status === RepoStatus.Initializing || repo.status === RepoStatus.CheckingStatus) {
						try {
							await repo.initTask.p;
						} catch (error) {
							this._logService.error(`Error during repo initialization: ${error}`);
						}
					}
				}));
			} finally {
				this._hasFinishedInitialization = true;
				this._onDidFinishInitialization.fire();
			}
		})();
		return this._initializePromise;
	}

	public isInitializing(): boolean {
		return !this._hasFinishedInitialization;
	}

	public override dispose(): void {
		super.dispose();

		this._isDisposed = true;

		for (const entry of this._repoIndexPolling.values()) {
			entry.poll.dispose();
			if (!entry.deferredP.isSettled) {
				entry.deferredP.cancel().catch(() => { });
			}
		}

		this._repoIndexPolling.clear();

		for (const repo of this._repos.values()) {
			if (repo.status === RepoStatus.Initializing || repo.status === RepoStatus.CheckingStatus) {
				repo.initTask.cts.cancel();
			}
		}

		this._initializedGitReposP.cancel();
		this._initializedGitHubRemoteReposP.cancel();
	}

	getAllRepos(): Iterable<RepoEntry> {
		return this._repos.values();
	}

	getRepoStatus(repo: RepoEntry): RepoStatus {
		return this._repos.get(repo.repo.rootUri)?.status ?? repo.status;
	}

	@LogExecTime(self => self._logService)
	private async openGitRepo(repo: RepoContext): Promise<void> {
		this._logService.trace(`CodeSearchRepoTracker.openGitRepo(${repo.rootUri})`);

		const existing = this._repos.get(repo.rootUri);
		if (existing) {
			if (existing.status === RepoStatus.Initializing) {
				try {
					return await existing.initTask.p;
				} catch (e) {
					if (isCancellationError(e)) {
						return;
					}

					throw e;
				}
			}
		}

		const initDeferredP = new DeferredPromise<void>();
		const initTask: InitTask = {
			p: initDeferredP.p,
			cts: new CancellationTokenSource(),
		};

		const initToken = initTask.cts.token;
		(async () => {
			try {
				// Do a status check to make sure the repo info is fully loaded
				// See #12954
				await this._gitExtensionService.getExtensionApi()?.getRepository(repo.rootUri)?.status();
			} catch {
				this._logService.trace(`CodeSearchRepoTracker.openRepo(${repo.rootUri}). git status check failed.`);
				// Noop, may still be ok even if the status check failed
			}

			if (initToken.isCancellationRequested) {
				return;
			}

			const updatedRepo = await this._gitService.getRepository(repo.rootUri);
			if (!updatedRepo && !this._simulationTestContext.isInSimulationTests) {
				this._logService.trace(`CodeSearchRepoTracker.openRepo(${repo.rootUri}). No current repo found after status check.`);

				/* __GDPR__
					"codeSearchRepoTracker.openGitRepo.error.noCurrentRepo" : {
						"owner": "mjbvz",
						"comment": "Information about errors when trying to resolve a remote"
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('codeSearchRepoTracker.openGitRepo.error.noCurrentRepo');

				this.updateRepoEntry(repo, { status: RepoStatus.NotResolvable, repo });
				return;
			}

			if (updatedRepo) {
				repo = updatedRepo;
			}
			this._repos.set(repo.rootUri, { status: RepoStatus.Initializing, repo, initTask });

			const remoteInfos = await this.getRemoteInfosForRepo(repo);
			if (initToken.isCancellationRequested) {
				return;
			}

			let remoteTelemetryType: GitRemoteTypeForTelemetry;
			if (remoteInfos.length) {
				const primaryRemote = remoteInfos[0];
				const remoteHost = primaryRemote.fetchUrl ? parseRemoteUrl(primaryRemote.fetchUrl) : undefined;
				remoteTelemetryType = remoteHost ? getRemoteTypeForTelemetry(remoteHost.host) : GitRemoteTypeForTelemetry.Unknown;
			} else {
				const allRemotes = Array.from(getOrderedRemoteUrlsFromContext(repo));
				if (allRemotes.length === 0) {
					remoteTelemetryType = GitRemoteTypeForTelemetry.NoRemotes;
				} else {
					for (const remote of allRemotes) {
						if (remote) {
							const remoteHost = parseRemoteUrl(remote);
							if (remoteHost) {
								const telemetryId = getRemoteTypeForTelemetry(remoteHost.host);
								if (telemetryId !== GitRemoteTypeForTelemetry.Unknown) {
									remoteTelemetryType = telemetryId;
									break;
								}
							}
						}
					}
				}
				remoteTelemetryType ??= GitRemoteTypeForTelemetry.Unknown;
			}
			/* __GDPR__
				"codeSearchRepoTracker.openGitRepo.remoteInfo" : {
					"owner": "mjbvz",
					"comment": "Information about the remote",
					"resolvedRemoteType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Identifies the primary remote's type " }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('codeSearchRepoTracker.openGitRepo.remoteInfo', {}, {
				resolvedRemoteType: remoteTelemetryType,
			});

			if (!remoteInfos.length) {
				this._logService.trace(`CodeSearchRepoTracker.openRepo(${repo.rootUri}). No valid github remote found. Remote urls: ${JSON.stringify(Array.from(getOrderedRemoteUrlsFromContext(repo)))}.`);

				this._telemetryService.sendInternalMSFTTelemetryEvent('codeSearchRepoTracker.error.couldNotResolveRemote.internal', {
					remoteUrls: JSON.stringify(coalesce(repo.remoteFetchUrls ?? [])),
				});

				/* __GDPR__
					"codeSearchRepoTracker.openGitRepo.error.couldNotResolveRemote" : {
						"owner": "mjbvz",
						"comment": "Information about errors when trying to resolve a remote",
						"repoRemoteFetchUrlsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of remote fetch urls on the git repo" }
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('codeSearchRepoTracker.openGitRepo.error.couldNotResolveRemote', {}, {
					repoRemoteFetchUrlsCount: repo.remoteFetchUrls?.length ?? 0,
				});

				this.updateRepoEntry(repo, { status: RepoStatus.NotResolvable, repo });
				return;
			}

			// TODO: Support checking index status for multiple remotes
			const primaryRemote = remoteInfos[0];
			this.updateRepoEntry(repo, {
				status: RepoStatus.CheckingStatus,
				repo,
				remoteInfo: primaryRemote,
				initTask,
			});

			await this.updateRepoStateFromEndpoint(repo, primaryRemote, false, initToken);
		})()
			.catch(() => { })
			.finally(() => {
				initDeferredP.complete();
			});

		this._repos.set(repo.rootUri, {
			status: RepoStatus.Initializing,
			repo,
			initTask
		});
	}

	private openGithubRemoteRepo(rootUri: URI, githubId: GithubRepoId): Promise<void> {
		this._logService.trace(`CodeSearchRepoTracker.openGithubRemoteRepo(${rootUri})`);

		const existing = this._repos.get(rootUri);
		if (existing) {
			if (existing.status === RepoStatus.Initializing) {
				return existing.initTask.p;
			}
		}

		const repo: RepoInfo = { rootUri };
		const remoteInfo: ResolvedRepoRemoteInfo = {
			repoId: githubId,
			fetchUrl: undefined,
		};

		const initCancellationTokenSource = new CancellationTokenSource();
		const initP = this.updateRepoStateFromEndpoint(repo, remoteInfo, false, initCancellationTokenSource.token).then(() => { });

		this._repos.set(rootUri, { status: RepoStatus.Initializing, repo, initTask: { p: initP, cts: initCancellationTokenSource } });
		return initP;
	}

	private async getRemoteInfosForRepo(repo: RepoContext): Promise<ResolvedRepoRemoteInfo[]> {
		const remoteInfos = Array.from(getOrderedRepoInfosFromContext(repo));

		// Fallback to checking the SSH config if no remotes were found
		if (!remoteInfos.length) {
			const other = await this.getGithubRemoteFromSshConfig(repo);
			if (other) {
				remoteInfos.push(other);
			}
		}

		// For now always prefer the github remotes
		remoteInfos.sort((a, b) => {
			if (a.repoId.type === 'github' && b.repoId.type !== 'github') {
				return -1;
			} else if (b.repoId.type === 'github' && a.repoId.type !== 'github') {
				return 1;
			}
			return 0;
		});

		return remoteInfos;
	}

	private async getGithubRemoteFromSshConfig(repo: RepoContext): Promise<ResolvedRepoRemoteInfo | undefined> {
		if (repo.rootUri.scheme !== Schemas.file) {
			return;
		}

		try {
			const execAsync = promisify(exec);
			const { stdout, stderr } = await execAsync('git -c credential.interactive=never fetch --dry-run', {
				cwd: repo.rootUri.fsPath,
				env: {
					GIT_SSH_COMMAND: 'ssh -v -o BatchMode=yes'
				}
			});

			const output = stdout + '\n' + stderr;

			const authMatch = output.match(/^Authenticated to ([^\s]+)\s/m);
			const fromMatch = output.match(/^From ([^:]+):([^/]+)\/([^\s]+)$/m);

			if (authMatch && fromMatch) {
				const authenticatedTo = authMatch[1];
				const owner = fromMatch[2];
				const repo = fromMatch[3].replace(/\.git$/, '');
				const remoteUrl = `ssh://${authenticatedTo}/${owner}/${repo}`;

				const githubRepoId = getGithubRepoIdFromFetchUrl(remoteUrl);
				if (githubRepoId) {
					return {
						repoId: githubRepoId,
						fetchUrl: remoteUrl
					};
				}
			}
			return undefined;
		} catch (e) {
			return undefined;
		}
	}

	public async updateRepoStateFromEndpoint(repo: RepoInfo, remoteInfo: ResolvedRepoRemoteInfo, force = false, token: CancellationToken): Promise<RepoEntry> {
		const existing = this._repos.get(repo.rootUri);
		if (!force && existing?.status === RepoStatus.Ready) {
			return existing;
		}

		this._logService.trace(`CodeSearchRepoTracker.updateRepoStateFromEndpoint(${repo.rootUri}). Checking status from endpoint.`);

		const newState = await raceCancellationError(this.getRepoIndexStatusFromEndpoint(repo, remoteInfo, token), token);
		this._logService.trace(`CodeSearchRepoTracker.updateRepoStateFromEndpoint(${repo.rootUri}). Updating state to ${newState.status}.`);

		this.updateRepoEntry(repo, newState);

		if (newState.status === RepoStatus.BuildingIndex) {
			// Trigger polling but don't block
			this.pollForRepoIndexingToComplete(repo).catch(() => { });
		}

		return newState;
	}

	private async getRepoIndexStatusFromEndpoint(repo: RepoInfo, remoteInfo: ResolvedRepoRemoteInfo, token: CancellationToken): Promise<RepoEntry> {
		const couldNotCheckStatus: RepoEntry = {
			status: RepoStatus.CouldNotCheckIndexStatus,
			repo,
			remoteInfo,
		};

		let statusResult: Result<RemoteCodeSearchIndexState, Error>;
		if (remoteInfo.repoId.type === 'github') {
			const authToken = await this.getGithubAccessToken(true);
			if (!authToken) {
				this._logService.error(`CodeSearchRepoTracker.getIndexedStatus(${remoteInfo.repoId}). Failed to fetch indexing status. No valid github auth token.`);
				return {
					status: RepoStatus.NotAuthorized,
					repo,
					remoteInfo,
				};
			}

			statusResult = await this._githubCodeSearchService.getRemoteIndexState(authToken, remoteInfo.repoId, token);
		} else if (remoteInfo.repoId.type === 'ado') {
			const authToken = (await this._authenticationService.getAdoAccessTokenBase64({ silent: true }));
			if (!authToken) {
				this._logService.error(`CodeSearchRepoTracker.getIndexedStatus(${remoteInfo.repoId}). Failed to fetch indexing status. No valid ado auth token.`);
				return {
					status: RepoStatus.NotAuthorized,
					repo,
					remoteInfo,
				};
			}

			statusResult = await this._adoCodeSearchService.getRemoteIndexState(authToken, remoteInfo.repoId, token);
		} else {
			return couldNotCheckStatus;
		}

		if (!statusResult.isOk()) {
			return couldNotCheckStatus;
		}

		switch (statusResult.val.status) {
			case RemoteCodeSearchIndexStatus.Ready:
				return {
					status: RepoStatus.Ready,
					repo: repo,
					remoteInfo,
					indexedCommit: statusResult.val.indexedCommit,
				};

			case RemoteCodeSearchIndexStatus.BuildingIndex:
				return { status: RepoStatus.BuildingIndex, repo, remoteInfo };

			case RemoteCodeSearchIndexStatus.NotYetIndexed:
				return { status: RepoStatus.NotYetIndexed, repo, remoteInfo };

			case RemoteCodeSearchIndexStatus.NotIndexable:
				return { status: RepoStatus.NotIndexable, repo, remoteInfo };
		}
	}

	private async getGithubAccessToken(silent: boolean) {
		return (await this._authenticationService.getPermissiveGitHubSession({ silent }))?.accessToken
			?? (await this._authenticationService.getAnyGitHubSession({ silent }))?.accessToken;
	}

	private closeRepo(repo: RepoContext) {
		this._logService.trace(`CodeSearchRepoTracker.closeRepo(${repo.rootUri})`);

		const repoEntry = this._repos.get(repo.rootUri);
		if (!repoEntry) {
			return;
		}

		if (repoEntry.status === RepoStatus.Initializing || repoEntry.status === RepoStatus.CheckingStatus) {
			repoEntry.initTask.cts.cancel();
		}

		this._onDidRemoveRepo.fire(repoEntry);
		this._repos.delete(repo.rootUri);
	}

	public async triggerRemoteIndexing(triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		this._logService.trace(`RepoTracker.TriggerRemoteIndexing(${triggerReason}). started`);

		await this.initialize();

		this._logService.trace(`RepoTracker.TriggerRemoteIndexing(${triggerReason}). Repos: ${JSON.stringify(Array.from(this._repos.values(), r => ({
			rootUri: r.repo.rootUri.toString(),
			status: r.status,
		})), null, 4)}`);

		const allRepos = Array.from(this._repos.values());
		if (!allRepos.length) {
			return Result.error(TriggerRemoteIndexingError.noGitRepos);
		}

		if (allRepos.every(repo => repo.status === RepoStatus.Initializing)) {
			return Result.error(TriggerRemoteIndexingError.stillResolving);
		}

		if (allRepos.every(repo => repo.status === RepoStatus.NotResolvable)) {
			return Result.error(TriggerRemoteIndexingError.noRemoteIndexableRepos);
		}

		const candidateRepos = allRepos.filter(repo => repo.status !== RepoStatus.NotResolvable && repo.status !== RepoStatus.Initializing);

		const authToken = await this.getGithubAuthToken();
		if (this._isDisposed) {
			return Result.ok(true);
		}

		if (!authToken) {
			return Result.error(TriggerRemoteIndexingError.noValidAuthToken);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.Ready)) {
			return Result.error(TriggerRemoteIndexingError.alreadyIndexed);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.BuildingIndex || repo.status === RepoStatus.Ready)) {
			return Result.error(TriggerRemoteIndexingError.alreadyIndexing);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized)) {
			return Result.error(TriggerRemoteIndexingError.couldNotCheckIndexStatus);
		}

		const responses = await Promise.all(candidateRepos.map(repoEntry => {
			if (repoEntry.status === RepoStatus.NotYetIndexed) {
				return this.triggerRemoteIndexingOfRepo(repoEntry, triggerReason, telemetryInfo.addCaller('CodeSearchRepoTracker::triggerRemoteIndexing'));
			}
		}));

		const error = responses.find(r => r?.isError());
		return error ?? Result.ok(true);
	}

	public async updateAllRepoStatuses(): Promise<void> {
		await Promise.all(Array.from(this._repos.values(), repo => {
			switch (repo.status) {
				case RepoStatus.NotResolvable:
				case RepoStatus.Initializing:
				case RepoStatus.CheckingStatus:
					// Noop, nothing to refresh
					return;

				case RepoStatus.NotYetIndexed:
				case RepoStatus.NotIndexable:
				case RepoStatus.BuildingIndex:
				case RepoStatus.Ready:
				case RepoStatus.CouldNotCheckIndexStatus:
				case RepoStatus.NotAuthorized:
					return this.updateRepoStateFromEndpoint(repo.repo, repo.remoteInfo, true, CancellationToken.None).catch(() => { });
			}
		}));
	}

	private async getGithubAuthToken() {
		return (await this._authenticationService.getPermissiveGitHubSession({ silent: true }))?.accessToken
			?? (await this._authenticationService.getAnyGitHubSession({ silent: true }))?.accessToken;
	}

	public async triggerRemoteIndexingOfRepo(repoEntry: ResolvedRepoEntry, triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		this._logService.trace(`Triggering indexing for repo: ${repoEntry.remoteInfo.repoId}`);

		const authToken = await this.getGithubAuthToken();
		if (this._isDisposed) {
			return Result.ok(true);
		}

		if (!authToken) {
			return Result.error(TriggerRemoteIndexingError.noValidAuthToken);
		}

		// Update UI state as soon as possible if triggered by the user
		if (triggerReason === 'manual') {
			this.updateRepoEntry(repoEntry.repo, {
				...repoEntry,
				status: RepoStatus.BuildingIndex,
			});
		}

		const triggerSuccess = repoEntry.remoteInfo.repoId instanceof GithubRepoId
			? await this._githubCodeSearchService.triggerIndexing(authToken, triggerReason, repoEntry.remoteInfo.repoId, telemetryInfo)
			: await this._adoCodeSearchService.triggerIndexing(authToken, triggerReason, repoEntry.remoteInfo.repoId, telemetryInfo);

		if (this._isDisposed) {
			return Result.ok(true);
		}

		if (!triggerSuccess) {
			this._logService.error(`RepoTracker.TriggerRemoteIndexing(${triggerReason}). Failed to request indexing for '${repoEntry.remoteInfo.repoId}'.`);

			this.updateRepoEntry(repoEntry.repo, {
				...repoEntry,
				status: RepoStatus.NotYetIndexed,
			});

			return Result.error(TriggerRemoteIndexingError.errorTriggeringIndexing(repoEntry.remoteInfo.repoId));
		}

		this.updateRepoEntry(repoEntry.repo, {
			...repoEntry,
			status: RepoStatus.BuildingIndex,
		});

		return Result.ok(true);
	}

	public async tryAuthIfNeeded(_telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<PromiseLike<undefined> | undefined> {
		await raceCancellationError(this.initialize(), token);
		if (this._isDisposed) {
			return;
		}

		// See if there are any repos that we know for sure we are not authorized for
		const allRepos = Array.from(this.getAllRepos());
		const notAuthorizedRepos = allRepos.filter(repo => repo.status === RepoStatus.NotAuthorized) as ResolvedRepoEntry[];
		if (!notAuthorizedRepos.length) {
			return;
		}

		// TODO: only handles first repos of each type, but our other services also don't track tokens for multiple
		// repos in a workspace right now

		const firstGithubRepo = notAuthorizedRepos.find(repo => repo.remoteInfo.repoId.type === 'github');
		if (firstGithubRepo) {
			await this._codeSearchAuthService.tryAuthenticating(firstGithubRepo);
		}

		const firstAdoRepo = notAuthorizedRepos.find(repo => repo.remoteInfo.repoId.type === 'ado');
		if (firstAdoRepo) {
			await this._codeSearchAuthService.tryAuthenticating(firstAdoRepo);
		}
	}

	private updateRepoEntry(repo: RepoInfo, entry: RepoEntry): void {
		this._repos.set(repo.rootUri, entry);
		this._onDidAddOrUpdateRepo.fire(entry);
	}

	private pollForRepoIndexingToComplete(repo: RepoInfo): Promise<void> {
		this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri})`);

		const repoKey = repo.rootUri;

		const existing = this._repoIndexPolling.get(repoKey);
		if (existing) {
			existing.attemptNumber = 0; // reset
			return existing.deferredP.p;
		}

		const deferredP = new DeferredPromise<void>();
		const poll = new IntervalTimer();

		const pollEntry = { poll, deferredP, attemptNumber: 0 };
		this._repoIndexPolling.set(repoKey, pollEntry);

		const onComplete = () => {
			poll.cancel();
			deferredP.complete();
			this._repoIndexPolling.delete(repoKey);
		};

		poll.cancelAndSet(async () => {
			const currentRepoEntry = this._repos.get(repoKey);
			if (!currentRepoEntry || this._isDisposed) {
				// It's possible the repo has been closed since
				this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Repo no longer tracked.`);
				return onComplete();
			}

			if (currentRepoEntry.status === RepoStatus.BuildingIndex) {
				const attemptNumber = pollEntry.attemptNumber++;
				if (attemptNumber > this.maxPollingAttempts) {
					this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Max attempts reached. Stopping polling.`);
					if (!this._isDisposed) {
						this.updateRepoEntry(repo, { status: RepoStatus.CouldNotCheckIndexStatus, repo: currentRepoEntry.repo, remoteInfo: currentRepoEntry.remoteInfo });
					}
					return onComplete();
				}

				this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Checking endpoint for status.`);
				let polledState: RepoEntry | undefined;
				try {
					polledState = await this.getRepoIndexStatusFromEndpoint(currentRepoEntry.repo, currentRepoEntry.remoteInfo, CancellationToken.None);
				} catch {
					// noop
				}
				this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Got back new status from endpoint: ${polledState?.status}.`);

				switch (polledState?.status) {
					case RepoStatus.Ready: {
						this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Repo indexed successfully.`);
						if (!this._isDisposed) {
							this.updateRepoEntry(repo, polledState);
						}
						return onComplete();
					}
					case RepoStatus.BuildingIndex: {
						// Poll again
						return;
					}
					default: {
						// We got some other state, so stop polling
						if (!this._isDisposed) {
							this.updateRepoEntry(repo, polledState ?? { status: RepoStatus.CouldNotCheckIndexStatus, repo: currentRepoEntry.repo, remoteInfo: currentRepoEntry.remoteInfo });
						}
						return onComplete();
					}
				}
			} else {
				this._logService.trace(`CodeSearchRepoTracker.startPollingForRepoIndexingComplete(${repo.rootUri}). Found unknown repo state: ${currentRepoEntry.status}. Stopping polling`);
				return onComplete();
			}
		}, this._repoIndexPollingInterval);

		return deferredP.p;
	}

	public async diffWithIndexedCommit(repoInfo: RepoEntry): Promise<CodeSearchDiff | undefined> {
		if (isGitHubRemoteRepository(repoInfo.repo.rootUri)) {
			// TODO: always assumes no diff. Can we get a real diff somehow?
			return { changes: [] };
		}

		const doDiffWith = async (ref: string): Promise<Change[] | undefined> => {
			try {
				return await this._gitService.diffWith(repoInfo.repo.rootUri, ref);
			} catch (e) {
				this._logService.trace(`CodeSearchRepoTracker.diffWithIndexedCommit(${repoInfo.repo.rootUri}). Could not compute diff against: ${ref}. Error: ${e}`);
			}
		};

		if (repoInfo.status === RepoStatus.NotYetIndexed) {
			const changes = await doDiffWith('@{upstream}');
			return changes ? { changes } : undefined;
		}

		if (repoInfo.status === RepoStatus.Ready) {
			const changesAgainstIndexedCommit = repoInfo.indexedCommit ? await doDiffWith(repoInfo.indexedCommit) : undefined;
			if (changesAgainstIndexedCommit) {
				return { changes: changesAgainstIndexedCommit, mayBeOutdated: false };
			}

			this._logService.trace(`CodeSearchRepoTracker.diffWithIndexedCommit(${repoInfo.repo.rootUri}). Falling back to diff against upstream.`);

			const changesAgainstUpstream = await doDiffWith('@{upstream}');
			if (changesAgainstUpstream) {
				return { changes: changesAgainstUpstream, mayBeOutdated: true };
			}

			this._logService.trace(`CodeSearchRepoTracker.diffWithIndexedCommit(${repoInfo.repo.rootUri}). Could not compute any diff.`);
		}

		return undefined;
	}

	private updateIndexedCommitForAllRepos(): void {
		for (const repo of this._repos.values()) {
			if (repo.status !== RepoStatus.Ready) {
				continue;
			}

			this.getRepoIndexStatusFromEndpoint(repo.repo, repo.remoteInfo, CancellationToken.None)
				.then(
					(newStatus) => {
						if (this._isDisposed) {
							return;
						}

						if (newStatus.status === RepoStatus.Ready && newStatus.indexedCommit !== repo.indexedCommit) {
							this.updateRepoEntry(repo.repo, newStatus);
						}
					},
					() => {
						// Noop
					});
		}
	}
}
