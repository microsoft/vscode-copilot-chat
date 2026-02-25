/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ChatSessionWorktreeProperties } from './chatSessionWorktreeService';

export interface WorkspaceFolderEntry {
	readonly folderPath: string;
	readonly timestamp: number;
}

export interface ChatSessionMetadataFile {
	worktreeProperties?: ChatSessionWorktreeProperties;
	workspaceFolder?: WorkspaceFolderEntry;
}

export const IChatSessionMetadataStore = createServiceIdentifier<IChatSessionMetadataStore>('IChatSessionMetadataStore');

export interface IChatSessionMetadataStore {
	readonly _serviceBrand: undefined;
	deleteSessionMetadata(sessionId: string): Promise<void>;
	storeWorktreeInfo(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void>;
	storeWorkspaceFolderInfo(sessionId: string, entry: WorkspaceFolderEntry): Promise<void>;

	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getSessionWorkspaceFolder(sessionId: string): Promise<vscode.Uri | undefined>;
	getUsedWorkspaceFolders(): Promise<WorkspaceFolderEntry[]>;
}
