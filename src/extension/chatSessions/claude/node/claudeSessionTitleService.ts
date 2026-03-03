/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile } from 'fs/promises';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { URI } from '../../../../util/vs/base/common/uri';
import { IFolderRepositoryManager } from '../../../chatSessions/common/folderRepositoryManager';
import { getProjectFolders } from './claudeProjectFolders';

// #region Service Interface

export const IClaudeSessionTitleService = createServiceIdentifier<IClaudeSessionTitleService>('IClaudeSessionTitleService');

/**
 * Service for managing Claude session titles.
 *
 * Provides a single abstraction for setting session titles, used by both:
 * - The `titleProvider` callback (auto-generated LLM titles after first message)
 * - The rename command (user-initiated title changes via F2 / context menu)
 *
 * Titles are persisted as `custom-title` entries appended to the session's JSONL file,
 * ensuring they survive cache invalidation and VS Code restarts.
 */
export interface IClaudeSessionTitleService {
	readonly _serviceBrand: undefined;

	/**
	 * Set a title for a Claude session.
	 * Appends a `custom-title` entry to the session's JSONL file.
	 */
	setTitle(sessionId: string, title: string): Promise<void>;
}

// #endregion

// #region Service Implementation

export class ClaudeSessionTitleService implements IClaudeSessionTitleService {
	declare _serviceBrand: undefined;

	constructor(
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
		@INativeEnvService private readonly _nativeEnvService: INativeEnvService,
		@IFolderRepositoryManager private readonly _folderRepositoryManager: IFolderRepositoryManager,
	) { }

	async setTitle(sessionId: string, title: string): Promise<void> {
		const sessionFileUri = await this._resolveSessionFile(sessionId);
		if (!sessionFileUri) {
			this._logService.warn(`[ClaudeSessionTitleService] Could not find session file for: ${sessionId}`);
			return;
		}

		const entry = JSON.stringify({
			type: 'custom-title',
			customTitle: title,
			sessionId,
		});

		try {
			await appendFile(sessionFileUri.fsPath, '\n' + entry, { encoding: 'utf8' });
		} catch (e) {
			this._logService.error(e, `[ClaudeSessionTitleService] Failed to write custom-title entry: ${sessionFileUri}`);
		}
	}

	/**
	 * Resolve the JSONL file path for a given session ID by scanning
	 * the workspace's project directories.
	 */
	private async _resolveSessionFile(sessionId: string): Promise<URI | undefined> {
		const projectFolders = await getProjectFolders(this._workspace, this._folderRepositoryManager);

		for (const { slug } of projectFolders) {
			const sessionFileUri = URI.joinPath(
				this._nativeEnvService.userHome,
				'.claude', 'projects', slug, `${sessionId}.jsonl`
			);

			try {
				await this._fileSystem.stat(sessionFileUri);
				return sessionFileUri;
			} catch {
				continue;
			}
		}

		return undefined;
	}
}

// #endregion
