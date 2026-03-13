/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatSessionWorktreeProperties } from '../chatSessionWorktreeService';
import { IChatSessionMetadataStore, WorkspaceFolderEntry } from '../chatSessionMetadataStore';
import { IWorkspaceInfo } from '../workspaceInfo';

export class MockChatSessionMetadataStore implements IChatSessionMetadataStore {
	declare _serviceBrand: undefined;

	private readonly _worktreeProperties = new Map<string, ChatSessionWorktreeProperties>();
	private readonly _workspaceFolders = new Map<string, WorkspaceFolderEntry>();
	private readonly _additionalWorkspaces = new Map<string, IWorkspaceInfo[]>();
	private readonly _firstUserMessages = new Map<string, string>();

	async deleteSessionMetadata(sessionId: string): Promise<void> {
		this._worktreeProperties.delete(sessionId);
		this._workspaceFolders.delete(sessionId);
		this._additionalWorkspaces.delete(sessionId);
		this._firstUserMessages.delete(sessionId);
	}

	async storeWorktreeInfo(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void> {
		this._worktreeProperties.set(sessionId, properties);
	}

	async storeWorkspaceFolderInfo(sessionId: string, entry: WorkspaceFolderEntry): Promise<void> {
		this._workspaceFolders.set(sessionId, entry);
	}

	async getSessionIdForWorktree(_folder: vscode.Uri): Promise<string | undefined> {
		return undefined;
	}

	async getWorktreeProperties(sessionIdOrFolder: string | vscode.Uri): Promise<ChatSessionWorktreeProperties | undefined> {
		if (typeof sessionIdOrFolder === 'string') {
			return this._worktreeProperties.get(sessionIdOrFolder);
		}
		return undefined;
	}

	async getSessionWorkspaceFolder(_sessionId: string): Promise<vscode.Uri | undefined> {
		return undefined;
	}

	async getUsedWorkspaceFolders(): Promise<WorkspaceFolderEntry[]> {
		return Array.from(this._workspaceFolders.values());
	}

	async getAdditionalWorkspaces(sessionId: string): Promise<IWorkspaceInfo[]> {
		return this._additionalWorkspaces.get(sessionId) ?? [];
	}

	async setAdditionalWorkspaces(sessionId: string, workspaces: IWorkspaceInfo[]): Promise<void> {
		this._additionalWorkspaces.set(sessionId, workspaces);
	}

	async getSessionFirstUserMessage(sessionId: string): Promise<string | undefined> {
		return this._firstUserMessages.get(sessionId);
	}

	async setSessionFirstUserMessage(sessionId: string, message: string): Promise<void> {
		this._firstUserMessages.set(sessionId, message);
	}
}
