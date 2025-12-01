/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IGitService } from '../../../platform/git/common/gitService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { getRepoId } from '../../chatSessions/vscode/copilotCodingAgentUtils';

const InstructionFileExtension = '.instruction.md';

export class OrganizationInstructionsProvider extends Disposable implements vscode.InstructionsProvider {

	private readonly _onDidChangeInstructions = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeInstructions = this._onDidChangeInstructions.event;

	private isFetching = false;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
	) {
		super();
	}

	private getCacheDir(): vscode.Uri | undefined {
		if (!this.extensionContext.storageUri) {
			return;
		}
		return vscode.Uri.joinPath(this.extensionContext.storageUri, 'githubInstructionsCache');
	}

	private getCacheFilename(orgLogin: string): string {
		return orgLogin + InstructionFileExtension;
	}

	async provideInstructions(
		options: vscode.InstructionQueryOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.CustomAgentResource[]> {
		try {
			// Get repository information from the active git repository
			const repoId = await getRepoId(this.gitService);
			if (!repoId) {
				this.logService.trace('[OrganizationInstructionsProvider] No active repository found');
				return [];
			}

			const orgLogin = repoId.org;

			// Read from cache first
			const cachedInstructions = await this.readFromCache(orgLogin);

			// Trigger async fetch to update cache
			this.fetchAndUpdateCache(orgLogin, options).catch(error => {
				this.logService.error(`[OrganizationInstructionsProvider] Error in background fetch: ${error}`);
			});

			return cachedInstructions;
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error in provideInstructions: ${error}`);
			return [];
		}
	}

	private async readFromCache(
		orgLogin: string,
	): Promise<vscode.CustomAgentResource[]> {
		try {
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationInstructionsProvider] No workspace open, cannot use cache');
				return [];
			}

			const cacheContents = await this.readCacheContents(orgLogin, cacheDir);
			if (cacheContents === undefined) {
				this.logService.trace(`[OrganizationInstructionsProvider] No cache found for org ${orgLogin}`);
				return [];
			}

			const instructions: vscode.CustomAgentResource[] = [];
			const fileName = this.getCacheFilename(orgLogin);
			const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
			instructions.push({
				name: orgLogin,
				description: '',
				uri: fileUri,
			});

			this.logService.trace(`[OrganizationInstructionsProvider] Loaded ${instructions.length} instructions from cache for org ${orgLogin}`);
			return instructions;
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async fetchAndUpdateCache(
		orgLogin: string,
		options: vscode.InstructionQueryOptions
	): Promise<void> {
		// Prevent concurrent fetches
		if (this.isFetching) {
			this.logService.trace('[OrganizationInstructionsProvider] Fetch already in progress, skipping');
			return;
		}

		this.isFetching = true;
		try {
			this.logService.trace(`[OrganizationInstructionsProvider] Fetching custom instructions for org ${orgLogin}`);

			const instructions = await this.octoKitService.getOrgCustomInstructions(orgLogin);
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationInstructionsProvider] No workspace open, cannot use cache');
				return;
			}

			if (!instructions) {
				this.logService.trace(`[OrganizationInstructionsProvider] No custom instructions found for org ${orgLogin}`);
				return;
			}

			// Ensure cache directory exists
			try {
				await this.fileSystem.stat(cacheDir);
			} catch (error) {
				// Directory doesn't exist, create it
				await this.fileSystem.createDirectory(cacheDir);
			}

			const existingInstructions = await this.readCacheContents(orgLogin, cacheDir);
			const hasChanges = instructions !== existingInstructions;

			if (!hasChanges) {
				this.logService.trace(`[OrganizationInstructionsProvider] No changes detected in cache for org ${orgLogin}`);
				return;
			}

			const fileName = this.getCacheFilename(orgLogin);
			const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
			await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(instructions));

			this.logService.trace(`[OrganizationInstructionsProvider] Updated cache with instructions for org ${orgLogin}`);

			// Fire event to notify consumers that instructions have changed
			this._onDidChangeInstructions.fire();
		} finally {
			this.isFetching = false;
		}
	}

	private async readCacheContents(orgLogin: string, cacheDir: vscode.Uri): Promise<string | undefined> {
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(orgLogin + InstructionFileExtension)) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					const content = await this.fileSystem.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					return text;
				}
			}
		} catch {
			// Directory might not exist yet or other errors
		}
		return undefined;
	}
}
