/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ChatSessionWorktreeFile } from './chatSessionWorktreeService';

export const IChatSessionWorkspaceFolderService = createServiceIdentifier<IChatSessionWorkspaceFolderService>('IChatSessionWorkspaceFolderService');

/**
 * Service for tracking workspace folder selections for chat sessions.
 * This is used in multi-root workspaces where some folders may not have git repositories.
 * In such cases, we track the workspace folder URI instead of a git repository.
 */
export interface IChatSessionWorkspaceFolderService {
	readonly _serviceBrand: undefined;
	getRecentFolders(): { folder: vscode.Uri; lastAccessTime: number }[];
	/**
	 * Delete a recent folder from all tracked sessions.
	 */
	deleteRecentFolder(folder: vscode.Uri): Promise<void>;
	deleteTrackedWorkspaceFolder(sessionId: string): Promise<void>;
	/**
	 * Track workspace folder selection for a session (for folders without git repos in multi-root workspaces)
	 */
	trackSessionWorkspaceFolder(sessionId: string, workspaceFolderUri: string): Promise<void>;

	/**
	 * Get the workspace folder associated with a session (if a workspace folder without git repo was selected)
	 */
	getSessionWorkspaceFolder(sessionId: string): vscode.Uri | undefined;

	/**
	 * Handle the completion of a request for a session.
	 * @param workspaceFolderUri
	 */
	handleRequestCompleted(workspaceFolderUri: vscode.Uri): Promise<void>;

	/**
	 * Get the changes in the workspace folder for a session.
	 * @param workspaceFolderUri
	 */
	getWorkspaceChanges(workspaceFolderUri: vscode.Uri): Promise<readonly ChatSessionWorktreeFile[] | undefined>;
}
