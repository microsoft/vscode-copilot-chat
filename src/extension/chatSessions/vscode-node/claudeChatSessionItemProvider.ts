/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ClaudeCodeSessionLoader } from '../../agents/claude/node/claudeCodeSessionLoader';

export class ClaudeSessionDataStore {
	private static StorageKey = 'claudeSessionIds';
	private _internalSessionToInitialPrompt: Map<string, string> = new Map();
	private _unresolvedNewSessions = new Map<string, { id: string; label: string }>();

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) { }

	/**
	 * This stuff is hopefully temporary until the chat session API is better aligned with the cli agent use-cases
	 */
	public setClaudeSessionId(internalSessionId: string, claudeSessionId: string) {
		this._unresolvedNewSessions.delete(internalSessionId);
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(ClaudeSessionDataStore.StorageKey) ?? {};
		curMap[internalSessionId] = claudeSessionId;
		curMap[claudeSessionId] = internalSessionId;
		this.extensionContext.workspaceState.update(ClaudeSessionDataStore.StorageKey, curMap);
	}

	public getUnresolvedSessions(): Map<string, { id: string; label: string }> {
		return this._unresolvedNewSessions;
	}

	/**
	 * Add a new session to the set of unresolved sessions. Will be resolved when setClaudeSessionId is called.
	 */
	public registerNewSession(prompt: string): string {
		const id = generateUuid();
		this._unresolvedNewSessions.set(id, { id, label: prompt });
		return id;
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
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(ClaudeSessionDataStore.StorageKey) ?? {};
		return curMap[sessionId];
	}
}

/**
 * Chat session item provider for Claude Code.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;
	private readonly _sessionLoader: ClaudeCodeSessionLoader;

	constructor(
		private readonly sessionStore: ClaudeSessionDataStore,
		@IFileSystemService fileSystemService: IFileSystemService,
		@ILogService logService: ILogService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		super();
		this._sessionLoader = new ClaudeCodeSessionLoader(fileSystemService, logService, workspaceService);
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this._sessionLoader.getAllSessions(token);
		// const newSessions: vscode.ChatSessionItem[] = Array.from(this.sessionStore.getUnresolvedSessions().values()).map(session => ({
		// 	id: session.id,
		// 	label: session.label,
		// 	timing: {
		// 		startTime: Date.now()
		// 	},
		// 	iconPath: new vscode.ThemeIcon('star-add')
		// }));

		const diskSessions = sessions.map(session => ({
			id: this.sessionStore.getSessionId(session.id) ?? session.id,
			label: session.label,
			tooltip: `Claude Code session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			iconPath: new vscode.ThemeIcon('star-add')
		} satisfies vscode.ChatSessionItem));

		// return [...newSessions, ...diskSessions];
		return diskSessions;
	}

	public async provideNewChatSessionItem(options: {
		readonly prompt?: string;
		readonly history?: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>;
		metadata?: any;
	}, token: vscode.CancellationToken): Promise<vscode.ChatSessionItem> {
		const label = options.prompt ?? 'Claude Code';
		const internal = this.sessionStore.registerNewSession(label);
		this._onDidChangeChatSessionItems.fire();
		if (options.prompt) {
			this.sessionStore.setInitialPrompt(internal, options.prompt);
		}

		return {
			id: internal,
			label: options.prompt ?? 'Claude Code'
		};
	}
}
