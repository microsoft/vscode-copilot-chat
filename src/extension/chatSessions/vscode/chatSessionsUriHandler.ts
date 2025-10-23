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
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { EXTENSION_ID } from '../../common/constants';

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
				await this._fetchCheckoutAndOpenSession(existingRepo, branch, type, id);
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

			// TODO:@osortega, do you want to show a picker here if there are multiple workspaces?
			let folderToOpen: vscode.Uri | null = ((cachedWorkspaces && cachedWorkspaces.length > 0) ? cachedWorkspaces[0] : null);

			if (!folderToOpen) {
				// No cached workspaces, proceed to clone. @osortega, you can show something here if you want, the git extension will show a progress notification
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

		this.checkAndOpenPendingSession();
	}

	public canHandleUri(uri: vscode.Uri): boolean {
		return Object.values(UriHandlerPaths).includes(uri.path as UriHandlerPaths);
	}

	/**
	 * Check for pending chat sessions that were saved before cloning and opening workspace.
	 * This should be called when the extension activates in a new workspace.
	 */
	public async checkAndOpenPendingSession(): Promise<void> {
		const pendingSession = this._extensionContext.globalState.get<{
			type: string;
			id: string;
			url: string;
			branch: string;
			timestamp: number;
		}>(PENDING_CHAT_SESSION_STORAGE_KEY);

		if (pendingSession) {
			// Check if the pending session is recent (within 10 minutes)
			const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
			if (pendingSession.timestamp < tenMinutesAgo) {
				// Clear expired pending session
				await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, undefined);
			}

			// Check that the folder we're expecting to be opened is actually open
			const repository = this._getAlreadyOpenWorkspace(this._gitExtensionService.getExtensionApi()!, pendingSession.url);
			if (!repository) {
				// The expected repository is not open.
				return;
			}

			return this._fetchCheckoutAndOpenSession(repository, pendingSession.branch, pendingSession.type, pendingSession.id);
		}
	}

	private _getAlreadyOpenWorkspace(gitApi: API, cloneUri: string): Repository | undefined {
		const lowerCloneUri = cloneUri.toLowerCase();
		const repositories = gitApi.repositories.filter(repo => repo.rootUri.toString().toLowerCase() === lowerCloneUri);
		return repositories.length > 0 ? repositories[0] : undefined;
	}

	private async _fetchCheckoutAndOpenSession(repository: Repository, branch: string, sessionType: string, sessionId: string): Promise<void> {
		await repository.fetch({ ref: branch });
		// TODO:@osortega, if the workspace is dirty then the checkout won't work
		try {
			await repository.checkout(branch);
		} catch (err) {
			// maybe repo working tree was dirty
		}
		await this._openGitHubSession(sessionType, sessionId, null, null);
	}
}