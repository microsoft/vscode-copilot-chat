/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { encodeBase64, VSBuffer } from '../../../util/vs/base/common/buffer';
import { EXTENSION_ID } from '../../common/constants';
import { getRepoId } from './copilotCodingAgentUtils';

const GHPR_EXTENSION_ID = 'GitHub.vscode-pull-request-github';
export enum UriHandlerPaths {
	OpenSession = '/openAgentSession',
	External_OpenPullRequestWebview = '/open-pull-request-webview',
}

export const UriHandlers = {
	[UriHandlerPaths.OpenSession]: EXTENSION_ID,
	[UriHandlerPaths.External_OpenPullRequestWebview]: GHPR_EXTENSION_ID
};
export type CustomUriHandler = vscode.UriHandler & { canHandleUri(uri: vscode.Uri): boolean };

export class ChatSessionsUriHandler implements CustomUriHandler {
	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
	) { }

	async handleUri(uri: vscode.Uri): Promise<void> {
		switch (uri.path) {
			case UriHandlerPaths.OpenSession:
				{
					const params = new URLSearchParams(uri.query);
					const type = params.get('type');
					const prId = params.get('id');
					if (type?.startsWith('copilot') && prId) {
						// For now we hardcode it to this type, eventually the full type should come in the URI
						return this._openGitHubSession('copilot-cloud-agent', prId);
					}
				}
		}
	}

	private async _openGitHubSession(type: string, id: string): Promise<void> {
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
}