/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';

/**
 * Supported resource types for GitHub organization resources.
 * Each type has its own subdirectory and file extension.
 */
export const enum GitHubResourceType {
	Instructions = 'instructions',
	Agents = 'agents',
}

/**
 * File extensions for each resource type.
 */
export const GitHubResourceFileExtensions: Record<GitHubResourceType, string> = {
	[GitHubResourceType.Instructions]: '.instructions.md',
	[GitHubResourceType.Agents]: '.agent.md',
};

export interface IOrganizationPromptFileCacheManager {
	/**
	 * Gets the cache directory for a specific organization and resource type.
	 * Format: github/<orgName>/<resourceType>/
	 */
	getCacheDir(orgName: string, resourceType: GitHubResourceType): vscode.Uri;

	/**
	 * Gets the root cache directory for all GitHub resources.
	 * Format: github/
	 */
	getRootCacheDir(): vscode.Uri;

	/**
	 * Gets the filename for a resource with the appropriate extension.
	 * @param name The base name of the resource (without extension)
	 * @param resourceType The type of resource
	 */
	getResourceFilename(name: string, resourceType: GitHubResourceType): string;

	/**
	 * Reads all cached resources for a specific organization and type.
	 * @returns Map of filename to content
	 */
	readCacheContents(orgName: string, resourceType: GitHubResourceType): Promise<Map<string, string>>;

	/**
	 * Reads a specific cached resource.
	 * @returns The content of the resource, or undefined if not found
	 */
	readCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string): Promise<string | undefined>;

	/**
	 * Writes a resource to the cache.
	 */
	writeCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string, content: string): Promise<void>;

	/**
	 * Deletes a resource from the cache.
	 */
	deleteCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string): Promise<void>;

	/**
	 * Deletes all cached resources for a specific organization and type.
	 */
	clearCache(orgName: string, resourceType: GitHubResourceType): Promise<void>;

	/**
	 * Deletes all cached resources for a specific organization (all types).
	 */
	clearOrgCache(orgName: string): Promise<void>;

	/**
	 * Lists all organizations that have cached resources.
	 */
	listCachedOrganizations(): Promise<string[]>;

	/**
	 * Lists all cached resource filenames for a specific organization and type.
	 */
	listCachedResources(orgName: string, resourceType: GitHubResourceType): Promise<string[]>;

	/**
	 * Checks if cache contents have changed.
	 */
	hasContentChanged(oldContents: Map<string, string>, newContents: Map<string, string>): boolean;

	/**
	 * Ensures the cache directory exists for a specific organization and type.
	 */
	ensureCacheDir(orgName: string, resourceType: GitHubResourceType): Promise<void>;

	/**
	 * Sanitizes a name to be safe for use as a filename.
	 */
	sanitizeFilename(name: string): string;

	/**
	 * Gets the URI for a specific cached resource file.
	 */
	getCacheFileUri(orgName: string, resourceType: GitHubResourceType, filename: string): vscode.Uri;
}

export const IOrganizationPromptFileCacheManager = createDecorator<IOrganizationPromptFileCacheManager>('IGitHubResourceCacheManager');

export class GitHubResourceCacheManager implements IOrganizationPromptFileCacheManager {

	private static readonly CACHE_ROOT = 'github';

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) { }

	getRootCacheDir(): vscode.Uri {
		return vscode.Uri.joinPath(this.extensionContext.globalStorageUri, GitHubResourceCacheManager.CACHE_ROOT);
	}

	getCacheDir(orgName: string, resourceType: GitHubResourceType): vscode.Uri {
		const sanitizedOrg = this.sanitizeFilename(orgName);
		return vscode.Uri.joinPath(
			this.extensionContext.globalStorageUri,
			GitHubResourceCacheManager.CACHE_ROOT,
			sanitizedOrg,
			resourceType
		);
	}

	getResourceFilename(name: string, resourceType: GitHubResourceType): string {
		const sanitizedName = this.sanitizeFilename(name);
		return sanitizedName + GitHubResourceFileExtensions[resourceType];
	}

	getCacheFileUri(orgName: string, resourceType: GitHubResourceType, filename: string): vscode.Uri {
		return vscode.Uri.joinPath(this.getCacheDir(orgName, resourceType), filename);
	}

	async readCacheContents(orgName: string, resourceType: GitHubResourceType): Promise<Map<string, string>> {
		const contents = new Map<string, string>();
		const cacheDir = this.getCacheDir(orgName, resourceType);
		const extension = GitHubResourceFileExtensions[resourceType];

		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(extension)) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					const content = await this.fileSystem.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					contents.set(filename, text);
				}
			}
		} catch {
			// Directory might not exist yet or other errors
			this.logService.trace(`[GitHubResourceCacheManager] Cache directory does not exist or error reading: ${cacheDir.toString()}`);
		}

		return contents;
	}

	async readCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string): Promise<string | undefined> {
		try {
			const fileUri = this.getCacheFileUri(orgName, resourceType, filename);
			const content = await this.fileSystem.readFile(fileUri);
			return new TextDecoder().decode(content);
		} catch {
			return undefined;
		}
	}

	async writeCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string, content: string): Promise<void> {
		await this.ensureCacheDir(orgName, resourceType);
		const fileUri = this.getCacheFileUri(orgName, resourceType, filename);
		await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[GitHubResourceCacheManager] Wrote cache file: ${fileUri.toString()}`);
	}

	async deleteCacheFile(orgName: string, resourceType: GitHubResourceType, filename: string): Promise<void> {
		try {
			const fileUri = this.getCacheFileUri(orgName, resourceType, filename);
			await this.fileSystem.delete(fileUri);
			this.logService.trace(`[GitHubResourceCacheManager] Deleted cache file: ${fileUri.toString()}`);
		} catch {
			// File might not exist
		}
	}

	async clearCache(orgName: string, resourceType: GitHubResourceType): Promise<void> {
		const cacheDir = this.getCacheDir(orgName, resourceType);
		const extension = GitHubResourceFileExtensions[resourceType];

		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(extension)) {
					await this.fileSystem.delete(vscode.Uri.joinPath(cacheDir, filename));
				}
			}
			this.logService.trace(`[GitHubResourceCacheManager] Cleared cache for ${orgName}/${resourceType}`);
		} catch {
			// Directory might not exist
		}
	}

	async clearOrgCache(orgName: string): Promise<void> {
		const sanitizedOrg = this.sanitizeFilename(orgName);
		const orgDir = vscode.Uri.joinPath(this.getRootCacheDir(), sanitizedOrg);

		try {
			await this.fileSystem.delete(orgDir, { recursive: true, useTrash: false });
			this.logService.trace(`[GitHubResourceCacheManager] Cleared all cache for org: ${orgName}`);
		} catch {
			// Directory might not exist
		}
	}

	async listCachedOrganizations(): Promise<string[]> {
		const orgs: string[] = [];
		const rootDir = this.getRootCacheDir();

		try {
			const entries = await this.fileSystem.readDirectory(rootDir);
			for (const [entry, fileType] of entries) {
				if (fileType === FileType.Directory) {
					orgs.push(entry);
				}
			}
		} catch {
			// Root directory might not exist yet
		}

		return orgs;
	}

	async listCachedResources(orgName: string, resourceType: GitHubResourceType): Promise<string[]> {
		const resources: string[] = [];
		const cacheDir = this.getCacheDir(orgName, resourceType);
		const extension = GitHubResourceFileExtensions[resourceType];

		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(extension)) {
					resources.push(filename);
				}
			}
		} catch {
			// Directory might not exist yet
		}

		return resources;
	}

	hasContentChanged(oldContents: Map<string, string>, newContents: Map<string, string>): boolean {
		// Check if the set of files changed
		if (oldContents.size !== newContents.size) {
			return true;
		}

		// Check if any file content changed
		for (const [filename, newContent] of newContents) {
			const oldContent = oldContents.get(filename);
			if (oldContent !== newContent) {
				return true;
			}
		}

		// Check if any old files are missing in new contents
		for (const filename of oldContents.keys()) {
			if (!newContents.has(filename)) {
				return true;
			}
		}

		return false;
	}

	async ensureCacheDir(orgName: string, resourceType: GitHubResourceType): Promise<void> {
		const cacheDir = this.getCacheDir(orgName, resourceType);

		// Create directory hierarchy: github/<org>/<type>
		const rootDir = this.getRootCacheDir();
		const sanitizedOrg = this.sanitizeFilename(orgName);
		const orgDir = vscode.Uri.joinPath(rootDir, sanitizedOrg);

		try {
			await this.fileSystem.stat(rootDir);
		} catch {
			await this.fileSystem.createDirectory(rootDir);
		}

		try {
			await this.fileSystem.stat(orgDir);
		} catch {
			await this.fileSystem.createDirectory(orgDir);
		}

		try {
			await this.fileSystem.stat(cacheDir);
		} catch {
			await this.fileSystem.createDirectory(cacheDir);
		}
	}

	sanitizeFilename(name: string): string {
		return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
	}
}
