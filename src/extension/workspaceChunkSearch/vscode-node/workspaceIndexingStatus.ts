/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from '@vscode/l10n';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICodeSearchAuthenticationService } from '../../../platform/remoteCodeSearch/node/codeSearchRepoAuth';
import { RepoStatus, ResolvedRepoEntry } from '../../../platform/remoteCodeSearch/node/codeSearchRepoTracker';
import { CodeSearchRemoteIndexStatus } from '../../../platform/workspaceChunkSearch/node/codeSearchChunkSearch';
import { LocalEmbeddingsIndexStatus } from '../../../platform/workspaceChunkSearch/node/embeddingsChunkSearch';
import { IWorkspaceChunkSearchService, WorkspaceIndexState } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { commandUri } from '../../linkify/common/commands';
import { buildLocalIndexCommandId, buildRemoteIndexCommandId } from './commands';


const reauthenticateCommandId = '_copilot.workspaceIndex.signInAgain';
const signInFirstTimeCommandId = '_copilot.workspaceIndex.signInToAnything';

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
	readonly indexKind: {
		readonly title: string;
		readonly learnMoreLink: string;
		readonly busy?: boolean;
	};
	readonly progress: {
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
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ICodeSearchAuthenticationService private readonly _codeSearchAuthService: ICodeSearchAuthenticationService,
		@IWorkspaceChunkSearchService _workspaceChunkSearch: IWorkspaceChunkSearchService,
	) {
		super();

		this._statusReporter = _workspaceChunkSearch;

		this._statusItem = this._register(vscode.window.createChatStatusItem('copilot.workspaceIndexStatus'));
		this._statusItem.title = statusTitle;

		this._register(this._statusReporter.onDidChangeIndexState(() => this._updateStatusItem()));

		this._register(this.registerCommands());

		// Write an initial status
		this._writeStatusItem({
			indexKind: {
				title: t`Checking index status`,
				learnMoreLink: 'https://aka.ms/copilot-chat-workspace-remote-index', // Top level overview of index
				busy: true
			},
			progress: undefined
		});

		// And kick off async update to get the real status
		this._updateStatusItem();
	}

	private currentUpdateRequestId = 0;

	private async _updateStatusItem(): Promise<void> {
		const id = ++this.currentUpdateRequestId;

		const state = await this._statusReporter.getIndexState();

		// Make sure a new request hasn't come in since we started
		if (id !== this.currentUpdateRequestId) {
			return;
		}

		const remoteIndexMessage = {
			title: t('Remotely indexed'),
			learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
		};

		// If we have remote index info, priority showing information related to it
		switch (state.remoteIndexState.status) {
			case CodeSearchRemoteIndexStatus.Indexed: {
				return this._writeStatusItem({
					indexKind: remoteIndexMessage,
					progress: undefined
				});
			}
			case CodeSearchRemoteIndexStatus.Indexing: {
				return this._writeStatusItem({
					indexKind: remoteIndexMessage,
					progress: {
						message: t('Building'),
						busy: true,
					},
				});
			}
			case CodeSearchRemoteIndexStatus.NotYetIndexed: {
				const local = await this.getLocalIndexStatusItem(state);
				if (id !== this.currentUpdateRequestId) {
					return;
				}

				return this._writeStatusItem({
					indexKind: local ? local.indexKind : {
						title: t('Remote index not yet built'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
					},
					progress: {
						message: (local?.progress?.message ? local?.progress?.message + ' ' : '') + `[${t`Build remote index`}](command:${buildRemoteIndexCommandId} "${t('Build Remote Workspace Index')}")`,
						busy: local?.progress?.busy ?? false,
					}
				});
			}
			case CodeSearchRemoteIndexStatus.Initializing:
				return this._writeStatusItem({
					indexKind: {
						title: t('Remote index'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
					},
					progress: {
						message: t('Checking status'),
						busy: true,
					},
				});

			case CodeSearchRemoteIndexStatus.CouldNotCheckIndexStatus: {
				const inaccessibleRepo = state.remoteIndexState.repos.find(repo =>
					repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized) as ResolvedRepoEntry | undefined;

				// Not signed in at all
				if (!this._authService.getAnyGitHubSession({ silent: true })) {
					return this._writeStatusItem({
						indexKind: {
							title: t('Remote index unavailable'),
							learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
						},
						progress: {
							message: t(`[Sign in](${commandUri(signInFirstTimeCommandId, [inaccessibleRepo])} "${t('Sign in to access the remote workspace index')}")`),
							busy: false,
						},
					});
				}

				// We either need to update auth or switch accounts
				return this._writeStatusItem({
					indexKind: {
						title: t('Remote index unavailable'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-remote-index',
					},
					progress: {
						message: t(`[Try re-authenticating](${commandUri(reauthenticateCommandId, [inaccessibleRepo])} "${t('Try signing in again to access the remote workspace index')}")`),
						busy: false,
					},
				});
			}

			case CodeSearchRemoteIndexStatus.NoRepos:
				// Fall through to local indexing
				break;
		}

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
					indexKind: {
						title: t('Locally indexed'),
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-local-index',
					},
					progress: await getProgress()
				};

			case LocalEmbeddingsIndexStatus.TooManyFilesForAutomaticIndexing:
				return {
					indexKind: {
						title: t`Basic index`,
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-basic-index'
					},
					progress: {
						message: `[${t`Build local index`}](command:${buildLocalIndexCommandId} "${t('Try to build a more advanced local index of the workspace.')}")`,
						busy: false
					},
				};

			case LocalEmbeddingsIndexStatus.TooManyFilesForAnyIndexing:
			default:
				return {
					indexKind: {
						title: t`Basic index`,
						learnMoreLink: 'https://aka.ms/vscode-copilot-workspace-basic-index'
					},
					progress: undefined
				};
		}
	}

	private _writeStatusItem(values: ChatStatusItemState | undefined) {
		if (!values) {
			this._statusItem.hide();
			return;
		}

		this._statusItem.show();

		this._statusItem.title = {
			label: statusTitle,
			link: values.indexKind.learnMoreLink
		};

		this._statusItem.description = coalesce([
			values.indexKind.title,
			values.indexKind.busy ? spinnerCodicon : undefined,
		]).join(' ');

		if (values.progress) {
			this._statusItem.detail = coalesce([
				values.progress.message,
				values.progress.busy ? spinnerCodicon : undefined
			]).join(' ');
		} else {
			this._statusItem.detail = '';
		}
	}

	private registerCommands(): IDisposable {
		const disposables = new DisposableStore();

		disposables.add(vscode.commands.registerCommand(signInFirstTimeCommandId, async (repo: ResolvedRepoEntry | undefined) => {
			if (!repo) {
				return;
			}

			return this._codeSearchAuthService.tryAuthenticating(repo);
		}));

		disposables.add(vscode.commands.registerCommand(reauthenticateCommandId, async (repo: ResolvedRepoEntry | undefined) => {
			if (!repo) {
				return;
			}

			return this._codeSearchAuthService.tryReauthenticating(repo);
		}));

		return disposables;
	}
}

