/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { API, Repository } from '../../../platform/git/vscode/git';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { encodeBase64, VSBuffer } from '../../../util/vs/base/common/buffer';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { EXTENSION_ID } from '../../common/constants';
import { getRepoId } from './copilotCodingAgentUtils';

const GHPR_EXTENSION_ID = 'GitHub.vscode-pull-request-github';
const PENDING_CHAT_SESSION_STORAGE_KEY = 'github.copilot.pendingChatSession';

export enum UriHandlerPaths {
	OpenSession = '/openAgentSession',
	External_OpenPullRequestWebview = '/open-pull-request-webview',
}

export const UriHandlers = {
	[UriHandlerPaths.OpenSession]: EXTENSION_ID,
	[UriHandlerPaths.External_OpenPullRequestWebview]: GHPR_EXTENSION_ID
};
export type CustomUriHandler = vscode.UriHandler & { canHandleUri(uri: vscode.Uri): boolean };

export class ChatSessionsUriHandler extends Disposable implements CustomUriHandler {
	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async handleUri(uri: vscode.Uri): Promise<void> {
		switch (uri.path) {
			case UriHandlerPaths.OpenSession:
				{
					const params = new URLSearchParams(uri.query);
					const type = params.get('type');
					const prId = params.get('id');
					const url = params.get('url');
					const branch = params.get('branch');
					if (type?.startsWith('copilot') && prId) {
						// For now we hardcode it to this type, eventually the full type should come in the URI
						return this._openGitHubSession('copilot-cloud-agent', prId, url, branch);
					}
				}
		}
	}

	private async _openGitHubSession(type: string, id: string, url: string | null, branch: string | null): Promise<void> {
		const gitAPI = this._gitExtensionService.getExtensionApi();
		if (gitAPI && url && branch) {
			// Check if we already have this repo open in the workspace
			const existingRepo = this._getAlreadyOpenWorkspace(gitAPI, url);
			if (existingRepo) {
				// Repo is already open, no need to clone
				await this.openPendingSession({ repo: existingRepo, branch, id, type });
				return;
			}

			// We're going to need a window reload, save the info to global state
			const pendingSession = {
				type,
				id,
				url,
				branch,
				timestamp: Date.now()
			};
			await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, pendingSession);

			// Check if we have workspaces associated with this repo
			const uri = vscode.Uri.parse(url);
			const cachedWorkspaces: vscode.Uri[] | null = await gitAPI.getRepositoryWorkspace(uri);

			// TODO:@osortega show picker to select workspace
			let folderToOpen: vscode.Uri | null = ((cachedWorkspaces && cachedWorkspaces.length > 0) ? cachedWorkspaces[0] : null);

			if (!folderToOpen) {
				// No cached workspaces, proceed to clone
				folderToOpen = await gitAPI.clone(vscode.Uri.parse(url), { postCloneAction: 'none', ref: branch });
			}
			if (!folderToOpen) {
				return;
			}

			// Reuse the window if there are no folders open
			const forceReuseWindow = ((vscode.workspace.workspaceFile === undefined) && (vscode.workspace.workspaceFolders === undefined));
			vscode.commands.executeCommand('vscode.openFolder', folderToOpen, { forceReuseWindow });
			return;
		}

		this.openPendingSession();
	}

	public canHandleUri(uri: vscode.Uri): boolean {
		return Object.values(UriHandlerPaths).includes(uri.path as UriHandlerPaths);
	}

	/**
	 * Check for pending chat sessions that were saved before cloning and opening workspace.
	 * This should be called when the extension activates in a new workspace.
	 */
	public async openPendingSession(details?: {
		repo: Repository;
		branch: string;
		id: string;
		type: string;
	}): Promise<void> {
		let repository: Repository | undefined;
		let branchName: string = '';
		let prId: string = '';
		let type: string = '';
		if (!details) {
			const pendingSession = this._extensionContext.globalState.get<{
				type: string;
				id: string;
				url: string;
				branch: string;
				timestamp: number;
			}>(PENDING_CHAT_SESSION_STORAGE_KEY);
			if (!pendingSession) {
				return;
			}
			// Check if the pending session is recent (within 10 minutes)
			const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
			if (pendingSession.timestamp > tenMinutesAgo) {
				// Clear expired pending session
				const gitAPI = await this.waitForGitExtensionAPI(this._gitExtensionService);
				if (!gitAPI) {
					return;
				}
				repository = this._getAlreadyOpenWorkspace(gitAPI, pendingSession.url);
				branchName = pendingSession.branch;
				prId = pendingSession.id;
				type = pendingSession.type;
			} else {
				this._logService.warn('Found pending sessions but they have expired at ' + new Date(pendingSession.timestamp).toISOString());
			}
		}
		// Return if we still don't have the details.
		if (!repository || !branchName || !prId || !type) {
			return;
		}

		await repository.fetch({ ref: branchName });
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			return;
		}
		const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
		const pullRequest = pullRequests.find(pr => pr.id === prId);
		if (!pullRequest) {
			return;
		}
		const encodedId = encodeBase64(VSBuffer.wrap(new TextEncoder().encode(pullRequest.number.toString())), false, true);
		const uri = vscode.Uri.from({ scheme: 'vscode-chat-session', authority: type, path: '/' + encodedId });
		await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, undefined);
		await vscode.commands.executeCommand('vscode.open', uri);

	}

	private async waitForGitExtensionAPI(gitExtensionService: IGitExtensionService): Promise<API | undefined> {
		let timeout = 5000;
		let api = gitExtensionService.getExtensionApi();
		while (!api || api.state === 'uninitialized') {
			api = gitExtensionService.getExtensionApi();
			await new Promise(resolve => setTimeout(resolve, 100));
			timeout -= 100;
			if (timeout <= 0) {
				break;
			}
		}
		return api;
	}

	private _getAlreadyOpenWorkspace(gitApi: API, cloneUri: string): Repository | undefined {
		const normalizedCloneUri = this._normalizeGitUri(cloneUri);

		for (const repo of gitApi.repositories) {
			// Check all remotes for this repository
			const remotes = repo.state.remotes;
			for (const remote of remotes) {
				for (const url of remote.fetchUrl ? [remote.fetchUrl] : []) {
					const normalizedRemoteUri = this._normalizeGitUri(url);
					if (normalizedRemoteUri === normalizedCloneUri) {
						return repo;
					}
				}
			}
		}

		return undefined;
	}

	private _normalizeGitUri(uri: string): string {
		return uri.toLowerCase()
			.replace(/\.git$/, '')
			.replace(/^git@github\.com:/, 'https://github.com/')
			.replace(/^https:\/\/github\.com\//, '')
			.replace(/\/$/, '');
	}
}