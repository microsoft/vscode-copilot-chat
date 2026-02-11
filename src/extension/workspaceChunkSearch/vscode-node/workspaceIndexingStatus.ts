/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from '@vscode/l10n';
import * as vscode from 'vscode';
import { ResolvedRepoRemoteInfo } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { ICodeSearchAuthenticationService } from '../../../platform/remoteCodeSearch/node/codeSearchRepoAuth';
import { CodeSearchRepoStatus } from '../../../platform/workspaceChunkSearch/node/codeSearch/codeSearchRepo';
import { LocalEmbeddingsIndexStatus } from '../../../platform/workspaceChunkSearch/node/embeddingsChunkSearch';
import { IWorkspaceChunkSearchService, WorkspaceIndexState } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { commandUri } from '../../linkify/common/commands';
import { buildLocalIndexCommandId, buildRemoteIndexCommandId } from './commands';


const reauthenticateCommandId = '_copilot.workspaceIndex.signInAgain';

interface WorkspaceIndexStateReporter {
	readonly onDidChangeIndexState: Event<void>;

	getIndexState(): Promise<WorkspaceIndexState>;
}

export class MockWorkspaceIndexStateReporter extends Disposable implements WorkspaceIndexStateReporter {
	private _indexState: WorkspaceIndexState;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	public readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	constructor(initialState: WorkspaceIndexState) {
		super();

		this._indexState = initialState;
	}

	async getIndexState(): Promise<WorkspaceIndexState> {
		return this._indexState;
	}

	updateIndexState(newState: WorkspaceIndexState): void {
		this._indexState = newState;
		this._onDidChangeIndexState.fire();
	}
}

interface ChatStatusItemState {
	readonly title: {
		readonly title: string;
		readonly learnMoreLink: string;
		readonly busy?: boolean;
	};
	readonly details: {
		readonly message: string;
		readonly busy: boolean;
	} | undefined;
}


const spinnerCodicon = '$(loading~spin)';
const statusTitle = t`Workspace Index`;

export class ChatStatusWorkspaceIndexingStatus extends Disposable {

	private readonly _statusItem: vscode.ChatStatusItem;

	private readonly _statusReporter: WorkspaceIndexStateReporter;

	/**
	 * Minimum number of outdated files to show.
	 *
	 * This prevents showing outdated files for normal editing. Small diffs can typically be recomputed very quickly
	 * when a request is made.
	 */
	private readonly minOutdatedFileCountToShow = 20;

	constructor(
		@IWorkspaceChunkSearchService workspaceChunkSearch: IWorkspaceChunkSearchService,
		@ICodeSearchAuthenticationService private readonly _codeSearchAuthService: ICodeSearchAuthenticationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._statusReporter = workspaceChunkSearch;

		this._statusItem = this._register(vscode.window.createChatStatusItem('copilot.workspaceIndexStatus'));
		this._statusItem.title = statusTitle;

		this._register(this._statusReporter.onDidChangeIndexState(() => this._updateStatusItem()));

		this._register(this.registerCommands());

		// Write an initial status
		this._writeStatusItem({
			title: {
				title: t`Checking index status`,
				learnMoreLink: 'https://aka.ms/copilot-chat-workspace-remote-index', // Top level overview of index
				busy: true
			},
			details: undefined
		});

		// And kick off async update to get the real status
		this._updateStatusItem();
	}

	private currentUpdateRequestId = 0;

	private async _updateStatusItem(): Promise<void> {
		const id = ++this.currentUpdateRequestId;
		this._logService.trace(`ChatStatusWorkspaceIndexingStatus::updateStatusItem(id=${id}): starting`);

		const state = await this._statusReporter.getIndexState();

		// Make sure a new request hasn't come in since we started
		if (id !== this.currentUpdateRequestId) {
			this._logService.trace(`ChatStatusWorkspaceIndexingStatus::updateStatusItem(id=${id}): skipping`);
			return;
		}

		const remotelyIndexedMessage = Object.freeze({
			title: t('Remotely indexed'),
			learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
		});

		// Azure-only fork: skip remote index status entirely.
		// Remote code search requires GitHub authentication which is not available.
		// Fall through directly to local indexing status.
		if (false) {
		// If we have remote index info, prioritize showing information related to it
		switch (state.remoteIndexState.status) {
			case 'initializing':
				return this._writeStatusItem({
					title: {
						title: t('Remote index'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
					},
					details: {
						message: t('Discovering repos'),
						busy: true,
					},
				});

			case 'loaded': {
				if (state.remoteIndexState.repos.length > 0) {
					if (state.remoteIndexState.repos.every(repo => repo.status === CodeSearchRepoStatus.NotIndexable)) {
						break;
					}

					// All repos are ready, check if external ingest is building
					if (state.remoteIndexState.externalIngestState?.status === CodeSearchRepoStatus.BuildingIndex) {
						return this._writeStatusItem({
							title: remotelyIndexedMessage,
							details: {
								message: state.remoteIndexState.externalIngestState.progressMessage || t('Building'),
								busy: true,
							},
						});
					}

					if (state.remoteIndexState.repos.every(repo => repo.status === CodeSearchRepoStatus.Ready)) {
						return this._writeStatusItem({
							title: remotelyIndexedMessage,
							details: undefined
						});
					}

					if (state.remoteIndexState.repos.some(repo => repo.status === CodeSearchRepoStatus.CheckingStatus || repo.status === CodeSearchRepoStatus.Resolving)) {
						return this._writeStatusItem({
							title: {
								title: t('Remote index'),
								learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
							},
							details: {
								message: t('Checking status'),
								busy: true,
							},
						});
					}

					if (state.remoteIndexState.repos.some(repo => repo.status === CodeSearchRepoStatus.BuildingIndex)) {
						return this._writeStatusItem({
							title: remotelyIndexedMessage,
							details: {
								message: t('Building'),
								busy: true,
							},
						});
					}

					if (state.remoteIndexState.repos.some(repo => repo.status === CodeSearchRepoStatus.NotYetIndexed)) {
						const local = await this.getLocalIndexStatusItem(state);
						if (id !== this.currentUpdateRequestId) {
							return;
						}

						return this._writeStatusItem({
							title: local ? local.title : {
								title: state.remoteIndexState.repos.every(repo => repo.status === CodeSearchRepoStatus.NotYetIndexed)
									? t('Remote index not yet built')
									: t('Remote index not yet built for a repo in the workspace'),
								learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
							},
							details: {
								message: (local?.details?.message ? local?.details?.message + ' ' : '') + `[${t`Build remote index`}](command:${buildRemoteIndexCommandId} "${t('Build Remote Workspace Index')}")`,
								busy: local?.details?.busy ?? false,
							}
						});
					}

					// We have a potential mix of statuses
					const readyRepos = state.remoteIndexState.repos.filter(repo => repo.status === CodeSearchRepoStatus.Ready);
					const errorRepos = state.remoteIndexState.repos.filter(repo => repo.status === CodeSearchRepoStatus.CouldNotCheckIndexStatus || repo.status === CodeSearchRepoStatus.NotAuthorized);

					if (errorRepos.length > 0) {
						const inaccessibleRepo = errorRepos[0].remoteInfo satisfies ResolvedRepoRemoteInfo | undefined;

						return this._writeStatusItem({
							title: {
								title: readyRepos.length
									? t('{0} repos with remote indexes', readyRepos.length)
									: t('Remote index unavailable'),
								learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
							},
							details: {
								message: readyRepos.length
									? t(`[Try re-authenticating for {0} additional repos](${commandUri(reauthenticateCommandId, [inaccessibleRepo])} "${t('Try signing in again to access the remote workspace index')}")`, errorRepos.length)
									: t(`[Try re-authenticating](${commandUri(reauthenticateCommandId, [inaccessibleRepo])} "${t('Try signing in again to access the remote workspace index ')}")`),
								busy: false,
							},
						});
					}
				}

				break;
			}
		}
		} // end Azure-only fork: skip remote index

		// For local indexing
		const localStatus = await this.getLocalIndexStatusItem(state);
		if (id !== this.currentUpdateRequestId) {
			return;
		}

		this._writeStatusItem(localStatus);
	}

	private async getLocalIndexStatusItem(state: WorkspaceIndexState): Promise<ChatStatusItemState | undefined> {
		const getProgress = async () => {
			const localState = await state.localIndexState.getState();
			if (localState) {
				const remaining = localState.totalFileCount - localState.indexedFileCount;
				if (remaining > this.minOutdatedFileCountToShow) {
					return {
						message: t`${remaining} files to index`,
						busy: true
					};
				}
			}
			return undefined;
		};

		switch (state.localIndexState.status) {
			case LocalEmbeddingsIndexStatus.Ready:
			case LocalEmbeddingsIndexStatus.UpdatingIndex:
				return {
					title: {
						title: t('Locally indexed'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-local-index',
					},
					details: await getProgress()
				};

			case LocalEmbeddingsIndexStatus.TooManyFilesForAutomaticIndexing:
				return {
					title: {
						title: t`Basic index`,
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-basic-index'
					},
					details: {
						message: `[${t`Build local index`}](command:${buildLocalIndexCommandId} "${t('Try to build a more advanced local index of the workspace.')}")`,
						busy: false
					},
				};

			case LocalEmbeddingsIndexStatus.Disabled:
				return undefined;

			case LocalEmbeddingsIndexStatus.TooManyFilesForAnyIndexing:
			default:
				return {
					title: {
						title: t`Basic index`,
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-basic-index'
					},
					details: undefined
				};
		}
	}

	private _writeStatusItem(values: ChatStatusItemState | undefined) {
		this._logService.trace(`ChatStatusWorkspaceIndexingStatus::_writeStatusItem()`);

		if (!values) {
			this._statusItem.hide();
			return;
		}

		this._statusItem.show();

		this._statusItem.title = {
			label: statusTitle,
			link: values.title.learnMoreLink
		};

		this._statusItem.description = coalesce([
			values.title.title,
			values.title.busy ? spinnerCodicon : undefined,
		]).join(' ');

		if (values.details) {
			this._statusItem.detail = coalesce([
				values.details.message,
				values.details.busy ? spinnerCodicon : undefined
			]).join(' ');
		} else {
			this._statusItem.detail = '';
		}
	}

	private registerCommands(): IDisposable {
		const disposables = new DisposableStore();

		disposables.add(vscode.commands.registerCommand(reauthenticateCommandId, async (repo: ResolvedRepoRemoteInfo | undefined) => {
			if (!repo) {
				return;
			}

			return this._codeSearchAuthService.tryReauthenticating(repo);
		}));

		return disposables;
	}
}

