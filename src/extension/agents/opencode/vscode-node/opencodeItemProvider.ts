/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { IOpenCodeSessionService } from '../node/opencodeSessionService';

/**
 * Data store for managing OpenCode session mappings and state
 * Similar to ClaudeSessionDataStore but for OpenCode
 */
export class OpenCodeSessionDataStore {
	private static StorageKey = 'opencodeSessionIds';
	private _internalSessionToInitialRequest: Map<string, vscode.ChatRequest> = new Map();
	private _unresolvedNewSessions = new Map<string, { id: string; label: string }>();

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService
	) { }

	/**
	 * Maps internal VS Code session ID to OpenCode session ID (bidirectional)
	 */
	public setOpenCodeSessionId(internalSessionId: string, opencodeSessionId: string): void {
		this._unresolvedNewSessions.delete(internalSessionId);
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(OpenCodeSessionDataStore.StorageKey) ?? {};
		curMap[internalSessionId] = opencodeSessionId;
		curMap[opencodeSessionId] = internalSessionId;
		this.extensionContext.workspaceState.update(OpenCodeSessionDataStore.StorageKey, curMap);
		
		this.logService.trace(`[OpenCodeSessionDataStore] Mapped session: ${internalSessionId} <-> ${opencodeSessionId}`);
	}

	/**
	 * Gets unresolved sessions that haven't been mapped to OpenCode session IDs yet
	 */
	public getUnresolvedSessions(): Map<string, { id: string; label: string }> {
		return this._unresolvedNewSessions;
	}

	/**
	 * Registers a new session that will be resolved when setOpenCodeSessionId is called
	 */
	public registerNewSession(prompt: string): string {
		const id = generateUuid();
		const label = this.generateSessionLabel(prompt);
		this._unresolvedNewSessions.set(id, { id, label });
		
		this.logService.trace(`[OpenCodeSessionDataStore] Registered new session: ${id} - ${label}`);
		return id;
	}

	/**
	 * Sets the initial request for a session (used for new sessions)
	 */
	public setInitialRequest(internalSessionId: string, request: vscode.ChatRequest): void {
		this._internalSessionToInitialRequest.set(internalSessionId, request);
		this.logService.trace(`[OpenCodeSessionDataStore] Set initial request for session: ${internalSessionId}`);
	}

	/**
	 * Gets and consumes the initial request for a session
	 */
	public getAndConsumeInitialRequest(sessionId: string): vscode.ChatRequest | undefined {
		const request = this._internalSessionToInitialRequest.get(sessionId);
		this._internalSessionToInitialRequest.delete(sessionId);
		
		if (request) {
			this.logService.trace(`[OpenCodeSessionDataStore] Consumed initial request for session: ${sessionId}`);
		}
		
		return request;
	}

	/**
	 * Bidirectional session ID mapping - takes either internal or OpenCode session ID
	 * and returns the corresponding one
	 */
	public getSessionId(sessionId: string): string | undefined {
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(OpenCodeSessionDataStore.StorageKey) ?? {};
		return curMap[sessionId];
	}

	/**
	 * Removes session mapping
	 */
	public removeSession(sessionId: string): void {
		const curMap: Record<string, string> = this.extensionContext.workspaceState.get(OpenCodeSessionDataStore.StorageKey) ?? {};
		const mappedId = curMap[sessionId];
		
		if (mappedId) {
			delete curMap[sessionId];
			delete curMap[mappedId];
			this.extensionContext.workspaceState.update(OpenCodeSessionDataStore.StorageKey, curMap);
			this.logService.trace(`[OpenCodeSessionDataStore] Removed session mapping: ${sessionId} <-> ${mappedId}`);
		}
		
		this._unresolvedNewSessions.delete(sessionId);
		this._internalSessionToInitialRequest.delete(sessionId);
	}

	/**
	 * Clears all session data
	 */
	public clearAll(): void {
		this.extensionContext.workspaceState.update(OpenCodeSessionDataStore.StorageKey, {});
		this._unresolvedNewSessions.clear();
		this._internalSessionToInitialRequest.clear();
		this.logService.trace('[OpenCodeSessionDataStore] Cleared all session data');
	}

	/**
	 * Generates a session label from a prompt
	 */
	private generateSessionLabel(prompt: string): string {
		// Clean and truncate prompt for label
		const cleaned = prompt.trim().replace(/\s+/g, ' ');
		if (cleaned.length <= 50) {
			return cleaned;
		}
		
		// Try to break at word boundary
		const truncated = cleaned.substring(0, 47);
		const lastSpace = truncated.lastIndexOf(' ');
		
		if (lastSpace > 20) {
			return truncated.substring(0, lastSpace) + '...';
		}
		
		return truncated + '...';
	}
}

/**
 * Chat session item provider for OpenCode
 * Provides list of available sessions and handles session creation
 */
export class OpenCodeChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	constructor(
		private readonly sessionStore: OpenCodeSessionDataStore,
		@IOpenCodeSessionService private readonly opencodeSessionService: IOpenCodeSessionService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	/**
	 * Refreshes the session list
	 */
	public refresh(): void {
		this.logService.trace('[OpenCodeChatSessionItemProvider] Refreshing session list');
		this._onDidChangeChatSessionItems.fire();
	}

	/**
	 * Provides the list of chat session items for the VS Code UI
	 */
	async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		try {
			this.logService.trace('[OpenCodeChatSessionItemProvider] Providing chat session items');
			
			const items: vscode.ChatSessionItem[] = [];
			
			// Add unresolved sessions (newly created but not yet mapped)
			for (const [id, session] of this.sessionStore.getUnresolvedSessions()) {
				items.push({
					id,
					label: session.label,
					providerName: 'opencode',
					createdAt: new Date() // We don't have creation time for unresolved sessions
				});
			}
			
			// Get sessions from OpenCode server
			const opencodeActiveSessions = await this.opencodeSessionService.getAllSessions(token);
			
			for (const session of opencodeActiveSessions) {
				// Check if this session has a VS Code mapping
				const internalId = this.sessionStore.getSessionId(session.id);
				
				items.push({
					id: internalId || session.id, // Use internal ID if mapped, otherwise OpenCode ID
					label: session.label,
					providerName: 'opencode',
					createdAt: session.timestamp
				});
			}
			
			// Sort by creation time (newest first)
			items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
			
			this.logService.info(`[OpenCodeChatSessionItemProvider] Provided ${items.length} session items`);
			return items;
			
		} catch (error) {
			this.logService.error('[OpenCodeChatSessionItemProvider] Failed to provide session items', error);
			// Return empty list on error to avoid breaking the UI
			return [];
		}
	}

	/**
	 * Creates a new chat session item
	 */
	async provideNewChatSessionItem(options: {
		prompt: string;
	}): Promise<vscode.ChatSessionItem> {
		try {
			this.logService.info(`[OpenCodeChatSessionItemProvider] Creating new session for prompt: "${options.prompt}"`);
			
			// Register the new session in our store
			const internalId = this.sessionStore.registerNewSession(options.prompt);
			
			// Create the session item
			const item: vscode.ChatSessionItem = {
				id: internalId,
				label: this.generateSessionLabel(options.prompt),
				providerName: 'opencode',
				createdAt: new Date()
			};
			
			// Notify that session list has changed
			this.refresh();
			
			this.logService.info(`[OpenCodeChatSessionItemProvider] Created new session item: ${internalId}`);
			return item;
			
		} catch (error) {
			this.logService.error('[OpenCodeChatSessionItemProvider] Failed to create new session item', error);
			throw error;
		}
	}

	/**
	 * Deletes a chat session (if supported)
	 */
	async deleteChatSessionItem?(id: string): Promise<void> {
		try {
			this.logService.info(`[OpenCodeChatSessionItemProvider] Deleting session: ${id}`);
			
			// Get the OpenCode session ID if this is an internal ID
			const opencodeSessionId = this.sessionStore.getSessionId(id) || id;
			
			// Try to delete from OpenCode server if it exists there
			try {
				// Note: This depends on OpenCode server supporting deletion
				// await this.opencodeSessionService.deleteSession(opencodeSessionId);
			} catch (deleteError) {
				this.logService.warn(`[OpenCodeChatSessionItemProvider] Could not delete from OpenCode server: ${deleteError}`);
			}
			
			// Remove from our session store
			this.sessionStore.removeSession(id);
			
			// Refresh the session list
			this.refresh();
			
			this.logService.info(`[OpenCodeChatSessionItemProvider] Deleted session: ${id}`);
			
		} catch (error) {
			this.logService.error(`[OpenCodeChatSessionItemProvider] Failed to delete session ${id}`, error);
			throw error;
		}
	}

	/**
	 * Generates a session label from a prompt
	 */
	private generateSessionLabel(prompt: string): string {
		const cleaned = prompt.trim().replace(/\s+/g, ' ');
		if (cleaned.length <= 50) {
			return cleaned;
		}
		
		const truncated = cleaned.substring(0, 47);
		const lastSpace = truncated.lastIndexOf(' ');
		
		if (lastSpace > 20) {
			return truncated.substring(0, lastSpace) + '...';
		}
		
		return truncated + '...';
	}
}