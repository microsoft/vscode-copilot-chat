/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';

export class ClaudeSessionDataStore {
	private static StorageKey = 'claudeSessionIds';
	private _internalSessionToInitialRequest: Map<string, vscode.ChatRequest> = new Map();
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

	public setInitialRequest(internalSessionId: string, request: vscode.ChatRequest) {
		this._internalSessionToInitialRequest.set(internalSessionId, request);
	}

	public getAndConsumeInitialRequest(sessionId: string): vscode.ChatRequest | undefined {
		const prompt = this._internalSessionToInitialRequest.get(sessionId);
		this._internalSessionToInitialRequest.delete(sessionId);
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

	constructor(
		private readonly sessionStore: ClaudeSessionDataStore,
		@IClaudeCodeSessionService private readonly claudeCodeSessionService: IClaudeCodeSessionService
	) {
		super();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.claudeCodeSessionService.getAllSessions(token);
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
		readonly request: vscode.ChatRequest;
		readonly prompt?: string;
		readonly history?: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>;
		metadata?: any;
	}, token: vscode.CancellationToken): Promise<vscode.ChatSessionItem> {
		const label = options.prompt ?? 'Claude Code';
		const internal = this.sessionStore.registerNewSession(label);
		this._onDidChangeChatSessionItems.fire();
		if (options.request) {
			this.sessionStore.setInitialRequest(internal, options.request);
		}

		return {
			id: internal,
			label: options.prompt ?? 'Claude Code'
		};
	}
}
