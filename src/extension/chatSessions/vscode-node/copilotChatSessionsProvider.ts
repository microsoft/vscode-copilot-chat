/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGithubRepoIdFromFetchUrl, IGitService } from '../../../platform/git/common/gitService';
import { PullRequestSearchItem } from '../../../platform/github/common/githubAPI';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { UriHandlerPaths, UriHandlers } from '../vscode/chatSessionsUriHandler';
import { ChatSessionContentBuilder } from './copilotChatSessionContentBuilder';

export class CopilotChatSessionsProvider extends Disposable implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider {
	public static readonly TYPE = 'copilot-cloud-agent';
	private readonly _onDidChangeChatSessionItems = this._register(new vscode.EventEmitter<void>());
	public onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;
	private readonly _onDidCommitChatSessionItem = this._register(new vscode.EventEmitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;
	private chatSessions: Map<number, PullRequestSearchItem> = new Map();

	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
	) {
		super();
	}

	async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		// TODO: Return same promise if fetching the chat session items multiple times
		const repo = this._gitService.activeRepository.get();
		if (!repo || !repo.remoteFetchUrls?.[0]) {
			return [];
		}
		const repoId = getGithubRepoIdFromFetchUrl(repo.remoteFetchUrls[0]);
		if (!repoId) {
			return [];
		}
		const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
		const sessionItems = await Promise.all(pullRequests.map(async pr => {
			const uri = await this.toOpenPullRequestWebviewUri({ owner: pr.repository.owner.login, repo: pr.repository.name, pullRequestNumber: pr.number });
			const prLinkTitle = vscode.l10n.t('Open pull request in VS Code');
			const description = new vscode.MarkdownString(`[#${pr.number}](${uri.toString()} "${prLinkTitle}")`);
			const session = {
				id: pr.number.toString(),
				label: pr.title,
				status: this.getSessionState(pr.state),
				description,
				timing: {
					startTime: new Date(pr.updatedAt).getTime(),
				},
				statistics: {
					insertions: pr.additions,
					deletions: pr.deletions
				},
				fullDatabaseId: pr.fullDatabaseId.toString(),
			};
			this.chatSessions.set(pr.number, pr);
			return session;
		}));
		return sessionItems;
	}

	async provideChatSessionContent(sessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const pr = this.chatSessions.get(Number(sessionId));
		if (!pr) {
			throw new Error(`Session not found for ID: ${sessionId}`);
		}
		const sessions = await this._octoKitService.getCopilotSessionsForPR(pr.fullDatabaseId.toString());
		const sessionContentBuilder = new ChatSessionContentBuilder(CopilotChatSessionsProvider.TYPE, (sessionId: string) => this._octoKitService.getSessionLogs(sessionId));
		const history = await sessionContentBuilder.buildSessionHistory(sessions, pr);
		return {
			history,
			activeResponseCallback: async () => { },
			requestHandler: undefined
		};
	}

	private getSessionState(state: string): vscode.ChatSessionStatus {
		switch (state) {
			case 'failed':
				return vscode.ChatSessionStatus.Failed;
			case 'in_progress': case 'queued':
				return vscode.ChatSessionStatus.InProgress;
			default:
				return vscode.ChatSessionStatus.Completed;
		}
	}

	private async toOpenPullRequestWebviewUri(params: {
		owner: string;
		repo: string;
		pullRequestNumber: number;
	}): Promise<vscode.Uri> {
		const query = JSON.stringify(params);
		const extensionId = UriHandlers[UriHandlerPaths.External_OpenPullRequestWebview];
		return await vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: extensionId, path: UriHandlerPaths.External_OpenPullRequestWebview, query }));
	}
}
