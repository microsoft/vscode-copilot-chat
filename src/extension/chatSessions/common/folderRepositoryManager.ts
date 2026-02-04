/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ChatSessionWorktreeProperties } from './chatSessionWorktreeService';

/**
 * Result of folder/repository resolution for a chat session.
 */
export interface FolderRepositoryInfo {
	/**
	 * The folder URI selected for this session.
	 * This could be a workspace folder or a git repository root.
	 */
	readonly folder: vscode.Uri | undefined;

	/**
	 * The git repository root URI if the selected folder contains a git repository.
	 * `undefined` if the folder is not a git repository.
	 */
	readonly repository: vscode.Uri | undefined;

	/**
	 * The worktree path if a worktree was created for this session.
	 * `undefined` if no worktree exists (e.g., plain folder or worktree creation failed).
	 */
	readonly worktree: vscode.Uri | undefined;

	/**
	 * The worktree properties associated with this session.
	 */
	readonly worktreeProperties: ChatSessionWorktreeProperties | undefined;

	/**
	 * Trust status of the folder/repository.
	 * - `true`: The folder/repository is trusted
	 * - `false`: Trust was requested but denied by user
	 * - `undefined`: Trust was not requested (options.promptForTrust was not set)
	 */
	readonly trusted: boolean | undefined;
}

/**
 * Options for getting folder/repository information.
 */
export interface GetFolderRepositoryOptions {
	/**
	 * If true, prompts the user for trust if the folder is not already trusted.
	 */
	readonly promptForTrust: true;

	readonly stream: vscode.ChatResponseStream;
}

/**
 * MRU (Most Recently Used) folder/repository entry.
 */
export interface FolderRepositoryMRUEntry {
	/**
	 * The folder URI.
	 */
	readonly folder: vscode.Uri;

	/**
	 * The repository URI if this is a git repository, undefined for plain folders.
	 */
	readonly repository: vscode.Uri | undefined;

	/**
	 * Timestamp of last access (milliseconds since epoch).
	 */
	readonly lastAccessed: number;

	/**
	 * Whether this entry was used in an untitled session.
	 */
	readonly isUntitledSessionSelection: boolean;
}

export const IFolderRepositoryManager = createServiceIdentifier<IFolderRepositoryManager>('IFolderRepositoryManager');

export interface IFolderRepositoryManager {
	readonly _serviceBrand: undefined;

	/**
	 * Track the selected folder for an untitled session.
	 */
	setUntitledSessionFolder(sessionId: string, folderUri: vscode.Uri): void;

	/**
	 * Get the selected folder URI for an untitled session.
	 */
	getUntitledSessionFolder(sessionId: string): vscode.Uri | undefined;

	/**
	 * Delete the tracked folder for an untitled session.
	 */
	deleteUntitledSessionFolder(sessionId: string): void;

	/**
	 * Get folder/repository/worktree/trust information for a session.
	 *
	 * This method resolves folder information using the following priority:
	 * 1. Worktree properties (if session has a worktree)
	 * 2. Session workspace folder (if tracked)
	 * 3. CLI session working directory (from session metadata)
	 *
	 * Trust checking is performed on the repository path (if git repo) or folder path
	 * (if plain folder). Worktree paths are NOT used for trust checking as they inherit
	 * trust from their parent repository.
	 */
	getFolderRepository(
		sessionId: string,
		options: GetFolderRepositoryOptions | undefined,
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo>;

	/**
	 * Initialize folder/repository for a session, creating a worktree if applicable.
	 *
	 * This method should be called when starting a request for an untitled session.
	 * It will:
	 * 1. Get the selected folder from memory or workspace folder service
	 * 2. Check if the folder contains a git repository
	 * 3. Verify trust on the repository/folder
	 * 4. Create a worktree if a git repo is found
	 * 5. Migrate uncommitted changes to worktree if requested
	 */
	initializeFolderRepository(
		sessionId: string | undefined,
		options: { stream: vscode.ChatResponseStream; uncommittedChangesAction?: 'move' | 'copy' | 'skip' },
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo>;

	/**
	 * Get list of most recently used folders and repositories.
	 *
	 * This is used for empty workspaces to show a list of previously used
	 * folders/repos in the folder selection dropdown.
	 *
	 * @returns Array of MRU entries sorted by last accessed time (newest first),
	 *          limited to 10 items, with non-existent paths filtered out
	 */
	getFolderMRU(): FolderRepositoryMRUEntry[];

	/**
	 * Delete an entry from the MRU list.
	 */
	deleteMRUEntry(folder: vscode.Uri): Promise<void>;

	/**
	 * Get the last used folder ID in untitled workspace.
	 * Used for defaulting the selection in the folder dropdown.
	 *
	 * @returns The folder path string or undefined if none was used
	 */
	getLastUsedFolderIdInUntitledWorkspace(): string | undefined;
}
