/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IClaudeCodeSessionService } from '../../agents/claude/node/sessionParser/claudeCodeSessionService';

/**
 * Chat session item provider for Claude Code.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {

	public static claudeSessionType = 'claude-code';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	constructor(
		@IClaudeCodeSessionService private readonly claudeCodeSessionService: IClaudeCodeSessionService,
		@IGitService private readonly gitService: IGitService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) {
		super();

		// Refresh session items when repositories change so badge state stays correct.
		// shouldShowBadge() reads gitService.repositories synchronously, which may be
		// incomplete while the git extension is still initializing.
		this._register(gitService.onDidOpenRepository(() => this._onDidChangeChatSessionItems.fire()));
		this._register(gitService.onDidCloseRepository(() => this._onDidChangeChatSessionItems.fire()));
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	private shouldShowBadge(): boolean {
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return true; // Empty window
		}
		if (workspaceFolders.length > 1) {
			return true; // Multi-root workspace
		}

		// Single-root workspace with multiple git repositories
		const repositories = this.gitService.repositories
			.filter(repository => repository.kind !== 'worktree');
		return repositories.length > 1;
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.claudeCodeSessionService.getAllSessions(token);
		const showBadge = this.shouldShowBadge();
		const diskSessions = sessions.map(session => {
			let badge: vscode.MarkdownString | undefined;
			if (session.folderName && showBadge) {
				badge = new vscode.MarkdownString(`$(folder) ${session.folderName}`);
				badge.supportThemeIcons = true;
			}

			return {
				resource: ClaudeSessionUri.forSessionId(session.id),
				label: session.label,
				badge,
				tooltip: `Claude Code session: ${session.label}`,
				timing: {
					created: session.firstMessageTimestamp.getTime(),
					lastRequestEnded: session.lastMessageTimestamp.getTime(),
				},
				iconPath: new vscode.ThemeIcon('claude')
			};
		});

		return diskSessions;
	}
}

export namespace ClaudeSessionUri {
	export function forSessionId(sessionId: string): vscode.Uri {
		return vscode.Uri.from({ scheme: ClaudeChatSessionItemProvider.claudeSessionType, path: '/' + sessionId });
	}

	export function getId(resource: vscode.Uri): string {
		if (resource.scheme !== ClaudeChatSessionItemProvider.claudeSessionType) {
			throw new Error('Invalid resource scheme for Claude Code session');
		}

		return resource.path.slice(1);
	}
}