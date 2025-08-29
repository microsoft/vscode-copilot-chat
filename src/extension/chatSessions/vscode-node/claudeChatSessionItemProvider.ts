/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Event } from '../../../util/vs/base/common/event';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ClaudeCodeSessionLoader } from '../../agents/claude/node/claudeCodeSessionLoader';

export class ClaudeSessionStore {
	private static StorageKey = 'claudeSessionIds';
	private _internalSessionToInitialPrompt: Map<string, string> = new Map();

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) { }

	/**
	 * This stuff is hopefully temporary until the chat session API is better aligned with the cli agent use-cases
	 */
	public setClaudeSessionId(internalSessionId: string, claudeSessionId: string) {
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(ClaudeSessionStore.StorageKey) ?? {};
		curMap[internalSessionId] = claudeSessionId;
		curMap[claudeSessionId] = internalSessionId;
		this.extensionContext.workspaceState.update(ClaudeSessionStore.StorageKey, curMap);
	}

	public setInitialPrompt(internalSessionId: string, prompt: string) {
		this._internalSessionToInitialPrompt.set(internalSessionId, prompt);
	}

	public getAndConsumeInitialPrompt(sessionId: string): string | undefined {
		const prompt = this._internalSessionToInitialPrompt.get(sessionId);
		this._internalSessionToInitialPrompt.delete(sessionId);
		return prompt;
	}

	/**
	 * This is bidirectional, takes either an internal or Claude session ID and returns the corresponding one.
	 */
	public getSessionId(sessionId: string): string | undefined {
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(ClaudeSessionStore.StorageKey) ?? {};
		return curMap[sessionId];
	}
}

/**
 * Chat session item provider for Claude Code.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemProvider implements vscode.ChatSessionItemProvider {
	public readonly onDidChangeChatSessionItems = Event.None;
	private readonly _sessionLoader: ClaudeCodeSessionLoader;

	constructor(
		private readonly sessionStore: ClaudeSessionStore,
		@IFileSystemService fileSystemService: IFileSystemService,
		@ILogService logService: ILogService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		this._sessionLoader = new ClaudeCodeSessionLoader(fileSystemService, logService, workspaceService);
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this._sessionLoader.getAllSessions(token);
		return sessions.map(session => ({
			id: session.id,
			label: session.label,
			tooltip: `Claude Code session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			iconPath: new vscode.ThemeIcon('star-add')
		} satisfies vscode.ChatSessionItem));
	}

	public async provideNewChatSessionItem(options: {
		readonly prompt?: string;
		readonly history?: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>;
		metadata?: any;
	}, token: vscode.CancellationToken): Promise<vscode.ChatSessionItem> {
		const internal = generateUuid();
		if (options.prompt) {
			this.sessionStore.setInitialPrompt(internal, options.prompt);
		}

		return {
			id: internal,
			label: options.prompt ?? 'Claude Code'
		};
	}
}
