/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';

/**
 * Chat session item controller for Claude Code.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemProvider extends Disposable {

	public static claudeSessionType = 'claude-code';

	private readonly controller: vscode.ChatSessionItemController;

	/**
	 * Maps Claude session IDs to the original chat session resource.
	 * Used to preserve the link between an untitled session and its Claude-backed session.
	 */
	private readonly sessionResourceOverrides = new Map<string, vscode.Uri>();

	constructor(
		@IClaudeCodeSessionService private readonly claudeCodeSessionService: IClaudeCodeSessionService
	) {
		super();

		this.controller = vscode.chat.createChatSessionItemController(
			ClaudeChatSessionItemProvider.claudeSessionType,
			// refreshHandler returns immediately - it never triggers work that would cause a loop.
			// Items are already in the collection when VS Code reads them.
			() => this.refresh()
		);
		this._register(this.controller);
	}

	/**
	 * Adds a single session item to the collection.
	 * Use this instead of refresh() when you know the specific session that was created.
	 */
	public addSession(sessionId: string, label: string, timestamp: Date, originalResource?: vscode.Uri): void {
		if (originalResource) {
			this.sessionResourceOverrides.set(sessionId, originalResource);
		}

		const resource = originalResource ?? ClaudeSessionUri.forSessionId(sessionId);
		const item = this.controller.createChatSessionItem(resource, label);
		item.tooltip = `Claude Code session: ${label}`;
		item.timing = {
			created: timestamp.getTime(),
			startTime: timestamp.getTime(),
		};
		item.iconPath = new vscode.ThemeIcon('star-add');

		this.controller.items.add(item);
	}

	/**
	 * Gets the Claude session ID for a given resource.
	 * Handles both direct Claude session URIs and overridden resources.
	 */
	public getSessionId(resource: vscode.Uri): string | undefined {
		// First check if this is a direct Claude session URI
		if (resource.scheme === ClaudeChatSessionItemProvider.claudeSessionType) {
			return resource.path.slice(1);
		}

		// Otherwise, look up in the overrides map (reverse lookup)
		for (const [sessionId, overrideResource] of this.sessionResourceOverrides) {
			if (overrideResource.toString() === resource.toString()) {
				return sessionId;
			}
		}

		return undefined;
	}

	public async refresh(): Promise<void> {
		const sessions = await this.claudeCodeSessionService.getAllSessions(CancellationToken.None);
		const items = sessions.map(session => {
			// Use the overridden resource if available, otherwise use the Claude session URI
			const resource = this.sessionResourceOverrides.get(session.id)
				?? ClaudeSessionUri.forSessionId(session.id);

			const item = this.controller.createChatSessionItem(
				resource,
				session.label
			);
			item.tooltip = `Claude Code session: ${session.label}`;
			item.timing = {
				created: session.timestamp.getTime(),
				startTime: session.timestamp.getTime(),
			};
			item.iconPath = new vscode.ThemeIcon('star-add');
			return item;
		});

		this.controller.items.replace(items);
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