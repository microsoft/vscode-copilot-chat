/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGithubRepoIdFromFetchUrl, GithubRepoId, IGitService } from '../../../platform/git/common/gitService';
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
	private chatSessionItemsPromise: Promise<vscode.ChatSessionItem[]> | undefined;

	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@IGitService private readonly _gitService: IGitService,
	) {
		super();
	}

	async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		if (this.chatSessionItemsPromise) {
			return this.chatSessionItemsPromise;
		}
		this.chatSessionItemsPromise = (async () => {
			const repoId = await this.getRepoId();
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
		})().finally(() => {
			this.chatSessionItemsPromise = undefined;
		});
		return this.chatSessionItemsPromise;
	}

	async provideChatSessionContent(sessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		let pr = this.chatSessions.get(Number(sessionId));
		if (!pr) {
			try {
				const repoId = await this.getRepoId();
				if (!repoId) {
					throw new Error(`Failed to determine GitHub repo from workspace`);
				}
				const pullRequests = await this._octoKitService.getCopilotPullRequestsForUser(repoId.org, repoId.repo);
				pr = pullRequests.find(pr => pr.number.toString() === sessionId);
				if (!pr) {
					throw new Error(`Pull request not found for ID: ${sessionId}`);
				}
			} catch (e) {
				throw new Error(`Session not found for ID: ${sessionId}`, e);
			}
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

	private async getRepoId(): Promise<GithubRepoId | undefined> {
		let timeout = 5000;
		while (!this._gitService.isInitialized) {
			await new Promise(resolve => setTimeout(resolve, 100));
			timeout -= 100;
			if (timeout <= 0) {
				break;
			}
		}

		const repo = this._gitService.activeRepository.get();
		if (repo && repo.remoteFetchUrls?.[0]) {
			return getGithubRepoIdFromFetchUrl(repo.remoteFetchUrls[0]);
		}
	}
}
