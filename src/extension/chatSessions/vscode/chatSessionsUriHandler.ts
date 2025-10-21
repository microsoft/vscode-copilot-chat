/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
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
			// Save session info to global storage before cloning
			const pendingSession = {
				type,
				id,
				url,
				branch,
				timestamp: Date.now()
			};
			await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, pendingSession);

			await gitAPI.clone(vscode.Uri.parse(url), { openFolder: true, ref: branch });
			return; // Exit early since we're cloning and will reopen
		}

		// Check if there's a pending session to open
		const pendingSession = this._extensionContext.globalState.get<{
			type: string;
			id: string;
			url: string;
			branch: string;
			timestamp: number;
		}>(PENDING_CHAT_SESSION_STORAGE_KEY);

		if (pendingSession) {
			// Clear the pending session from storage
			await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, undefined);

			// Use the pending session data
			id = pendingSession.id;
			type = pendingSession.type;
		}

		// Ensure the branch is checked out
		const repoId = await getRepoId(this._gitService);
		if (!repoId) {
			return;
		}
		const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
		const pullRequest = pullRequests.find(pr => pr.id === id);
		if (!pullRequest) {
			return;
		}
		const encodedId = encodeBase64(VSBuffer.wrap(new TextEncoder().encode(pullRequest.number.toString())), false, true);
		const uri = vscode.Uri.from({ scheme: 'vscode-chat-session', authority: type, path: '/' + encodedId });
		await vscode.commands.executeCommand('vscode.open', uri);
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
			if (pendingSession.timestamp > tenMinutesAgo) {
				// Open the session by calling the internal method
				await this._openGitHubSession(pendingSession.type, pendingSession.id, null, null);
			} else {
				// Clear expired pending session
				await this._extensionContext.globalState.update(PENDING_CHAT_SESSION_STORAGE_KEY, undefined);
			}
		}
	}
}