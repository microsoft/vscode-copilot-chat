/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { Uri } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ChatSessionWorktreeProperties } from './chatSessionWorktreeService';
import type { IWorkspaceInfo } from './workspaceInfo';

export interface WorkspaceFolderEntry {
	readonly folderPath: string;
	readonly timestamp: number;
}

export interface ChatSessionMetadataFile {
	worktreeProperties?: ChatSessionWorktreeProperties;
	workspaceFolder?: WorkspaceFolderEntry;
	additionalWorkspaces?: {
		worktreeProperties?: ChatSessionWorktreeProperties;
		workspaceFolder?: WorkspaceFolderEntry;
	}[];
	/**
	 * Whether the session metadata has been written to the Copilot CLI session state directory.
	 */
	writtenToDisc?: boolean;
}

export const IChatSessionMetadataStore = createServiceIdentifier<IChatSessionMetadataStore>('IChatSessionMetadataStore');

export interface IChatSessionMetadataStore {
	readonly _serviceBrand: undefined;
	deleteSessionMetadata(sessionId: string): Promise<void>;
	storeWorktreeInfo(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void>;
	storeWorkspaceFolderInfo(sessionId: string, entry: WorkspaceFolderEntry): Promise<void>;
	getSessionIdForWorktree(folder: vscode.Uri): Promise<string | undefined>;
	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getWorktreeProperties(folder: Uri): Promise<ChatSessionWorktreeProperties | undefined>;
	getSessionWorkspaceFolder(sessionId: string): Promise<vscode.Uri | undefined>;
	getUsedWorkspaceFolders(): Promise<WorkspaceFolderEntry[]>;
	getAdditionalWorkspaces(sessionId: string): Promise<IWorkspaceInfo[]>;
	setAdditionalWorkspaces(sessionId: string, workspaces: IWorkspaceInfo[]): Promise<void>;
}
