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
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { getRepoId } from '../../chatSessions/vscode/copilotCodingAgentUtils';

const InstructionFileExtension = '.instruction.md';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class OrganizationInstructionsProvider extends Disposable implements vscode.ChatInstructionsProvider {

	private readonly _onDidChangeInstructions = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeInstructions = this._onDidChangeInstructions.event;

	private isFetching = false;
	private pollingInterval: ReturnType<typeof setInterval> | undefined;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
	) {
		super();
		this.startPolling();
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
		options: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		try {
			const orgLogin = await this.determineOrganizationToUse();
			const cachedInstructions = orgLogin ? await this.readFromCache(orgLogin) : [];
			return cachedInstructions;
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error in provideInstructions: ${error}`);
			return [];
		}
	}

	/**
	 * Tries all user's organizations to find one with custom instructions.
	 * Returns the first organization login that has instructions, or undefined if none found.
	 */
	private async tryAllOrganizations(): Promise<string | undefined> {
		try {
			this.logService.trace('[OrganizationInstructionsProvider] Fetching list of user organizations');
			const organizations = await this.octoKitService.getUserOrganizations({ createIfNone: false });

			if (!organizations || organizations.length === 0) {
				this.logService.trace('[OrganizationInstructionsProvider] No organizations found for user');
				return undefined;
			}

			this.logService.trace(`[OrganizationInstructionsProvider] Trying ${organizations.length} organizations`);

			// Try each organization until we find one with instructions
			for (const org of organizations) {
				try {
					this.logService.trace(`[OrganizationInstructionsProvider] Trying organization: ${org}`);
					const instructions = await this.octoKitService.getOrgCustomInstructions(org, {});

					if (instructions) {
						this.logService.trace(`[OrganizationInstructionsProvider] Found instructions for organization: ${org}`);
						// Cache the instructions
						await this.cacheInstructions(org, instructions);
						return org;
					}
				} catch (error) {
					this.logService.trace(`[OrganizationInstructionsProvider] Error fetching instructions for ${org}: ${error}`);
					// Continue to next organization
				}
			}

			this.logService.trace('[OrganizationInstructionsProvider] No organization with instructions found');
			return undefined;
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error in tryAllOrganizations: ${error}`);
			return undefined;
		}
	}

	/**
	 * Determines which organization to use for instructions based on priority.
	 */
	private async determineOrganizationToUse(): Promise<string | undefined> {
		const cacheDir = this.getCacheDir();
		if (!cacheDir) {
			this.logService.trace('[OrganizationInstructionsProvider] No workspace open, cannot determine organization');
			return undefined;
		}

		// Check if current repository belongs to an organization with instructions
		const repoIds = await getRepoId(this.gitService);
		if (repoIds && repoIds.length > 0) {
			const currentOrgLogin = repoIds[0].org;
			const hasInstructions = await this.hasInstructionsInCache(currentOrgLogin, cacheDir);
			if (hasInstructions) {
				this.logService.trace(`[OrganizationInstructionsProvider] Using current repository's organization: ${currentOrgLogin}`);
				return currentOrgLogin;
			}
		}

		// Find any organization with instructions in cache
		return await this.findFirstCachedOrganization(cacheDir);
	}

	/**
	 * Checks if instructions exist in cache for a given organization
	 */
	private async hasInstructionsInCache(orgLogin: string, cacheDir: vscode.Uri): Promise<boolean> {
		const fileName = this.getCacheFilename(orgLogin);
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			return files.some(([name, type]) => type === FileType.File && name === fileName);
		} catch {
			return false;
		}
	}

	private async findFirstCachedOrganization(cacheDir: vscode.Uri): Promise<string | undefined> {
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(InstructionFileExtension)) {
					const orgLogin = filename.substring(0, filename.length - InstructionFileExtension.length);
					this.logService.trace(`[OrganizationInstructionsProvider] Using cached organization: ${orgLogin}`);
					return orgLogin;
				}
			}
		} catch (error) {
			this.logService.trace(`[OrganizationInstructionsProvider] Error reading cache directory: ${error}`);
		}
		return undefined;
	}

	private async readFromCache(
		orgLogin: string,
	): Promise<vscode.ChatResource[]> {
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

			const instructions: vscode.ChatResource[] = [];
			const fileName = this.getCacheFilename(orgLogin);
			const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
			instructions.push({ uri: fileUri });

			this.logService.trace(`[OrganizationInstructionsProvider] Loaded ${instructions.length} instructions from cache for org ${orgLogin}`);
			return instructions;
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async fetchAndUpdateCache(
		orgLogin: string | undefined,
	): Promise<void> {
		// Prevent concurrent fetches
		if (this.isFetching) {
			this.logService.trace('[OrganizationInstructionsProvider] Fetch already in progress, skipping');
			return;
		}

		this.isFetching = true;
		try {
			// If no orgLogin provided, try all organizations
			if (!orgLogin) {
				this.logService.trace('[OrganizationInstructionsProvider] No orgLogin provided, trying all organizations');
				orgLogin = await this.tryAllOrganizations();
				if (!orgLogin) {
					this.logService.trace('[OrganizationInstructionsProvider] No organization with instructions found');
					return;
				}
				// tryAllOrganizations already fetched and cached, just fire the event
				this._onDidChangeInstructions.fire();
				return;
			}

			this.logService.trace(`[OrganizationInstructionsProvider] Fetching custom instructions for org ${orgLogin}`);

			const instructions = await this.octoKitService.getOrgCustomInstructions(orgLogin, {});
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationInstructionsProvider] No workspace open, cannot use cache');
				return;
			}

			if (!instructions) {
				this.logService.trace(`[OrganizationInstructionsProvider] No custom instructions found for org ${orgLogin}`);
				return;
			}

			const existingInstructions = await this.readCacheContents(orgLogin, cacheDir);
			const hasChanges = instructions !== existingInstructions;

			if (!hasChanges) {
				this.logService.trace(`[OrganizationInstructionsProvider] No changes detected in cache for org ${orgLogin}`);
				return;
			}

			await this.cacheInstructions(orgLogin, instructions);
			this.logService.trace(`[OrganizationInstructionsProvider] Updated cache with instructions for org ${orgLogin}`);

			// Fire event to notify consumers that instructions have changed
			this._onDidChangeInstructions.fire();
		} finally {
			this.isFetching = false;
		}
	}

	/**
	 * Caches instructions for an organization
	 */
	private async cacheInstructions(orgLogin: string, instructions: string): Promise<void> {
		const cacheDir = this.getCacheDir();
		if (!cacheDir) {
			this.logService.trace('[OrganizationInstructionsProvider] No workspace open, cannot use cache');
			return;
		}

		// Ensure cache directory exists
		try {
			await this.fileSystem.stat(cacheDir);
		} catch (error) {
			// Directory doesn't exist, create it
			await this.fileSystem.createDirectory(cacheDir);
		}

		const fileName = this.getCacheFilename(orgLogin);
		const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
		await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(instructions));
	}

	private async readCacheContents(orgLogin: string, cacheDir: vscode.Uri): Promise<string | undefined> {
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename === this.getCacheFilename(orgLogin)) {
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

	private startPolling(): void {
		if (this.pollingInterval) {
			return;
		}

		this.logService.trace(`[OrganizationInstructionsProvider] Starting polling with interval: ${REFRESH_INTERVAL_MS}ms`);

		this.pollingInterval = setInterval(async () => {
			await this.refreshCache();
		}, REFRESH_INTERVAL_MS);

		// Register for disposal
		this._register(toDisposable(() => this.stopPolling()));
	}

	private stopPolling(): void {
		if (this.pollingInterval) {
			this.logService.trace('[OrganizationInstructionsProvider] Stopping polling');
			clearInterval(this.pollingInterval);
			this.pollingInterval = undefined;
		}
	}

	private async refreshCache(): Promise<void> {
		try {
			const orgLogin = await this.determineOrganizationToUse();
			await this.fetchAndUpdateCache(orgLogin);
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error in refreshCache: ${error}`);
		}
	}
}
