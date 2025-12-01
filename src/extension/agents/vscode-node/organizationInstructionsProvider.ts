/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import YAML from 'yaml';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IGitService } from '../../../platform/git/common/gitService';
import { CustomInstructionListItem, IOctoKitService } from '../../../platform/github/common/githubService';
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

			const cacheContents = await this.readCacheContents(cacheDir);
			if (cacheContents.size === 0) {
				this.logService.trace(`[OrganizationInstructionsProvider] No cache found for org ${orgLogin}`);
				return [];
			}

			const instructions: vscode.CustomAgentResource[] = [];

			for (const [filename, text] of cacheContents) {
				// Parse metadata from the file (name and description)
				const metadata = this.parseInstructionMetadata(text, filename);
				if (metadata) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					instructions.push({
						name: metadata.name,
						description: metadata.description,
						uri: fileUri,
					});
				}
			}

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

			// Ensure cache directory exists
			try {
				await this.fileSystem.stat(cacheDir);
			} catch (error) {
				// Directory doesn't exist, create it
				await this.fileSystem.createDirectory(cacheDir);
			}

			// Read existing cache contents before updating
			const existingContents = await this.readCacheContents(cacheDir);

			// Generate new cache contents
			const newContents = new Map<string, string>();
			for (const instruction of instructions) {
				const filename = this.sanitizeFilename(instruction.name) + InstructionFileExtension;

				// Generate instruction markdown file content
				const content = this.generateInstructionMarkdown(instruction);
				newContents.set(filename, content);
			}

			// Compare contents to detect changes
			const hasChanges = this.hasContentChanged(existingContents, newContents);

			if (!hasChanges) {
				this.logService.trace(`[OrganizationInstructionsProvider] No changes detected in cache for org ${orgLogin}`);
				return;
			}

			// Clear existing cache files
			const existingFiles = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of existingFiles) {
				if (fileType === FileType.File && filename.endsWith(InstructionFileExtension)) {
					await this.fileSystem.delete(vscode.Uri.joinPath(cacheDir, filename));
				}
			}

			// Write new cache files
			for (const [filename, content] of newContents) {
				const fileUri = vscode.Uri.joinPath(cacheDir, filename);
				await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(content));
			}

			this.logService.trace(`[OrganizationInstructionsProvider] Updated cache with ${instructions.length} instructions for org ${orgLogin}`);

			// Fire event to notify consumers that instructions have changed
			this._onDidChangeInstructions.fire();
		} finally {
			this.isFetching = false;
		}
	}

	private async readCacheContents(cacheDir: vscode.Uri): Promise<Map<string, string>> {
		const contents = new Map<string, string>();
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(InstructionFileExtension)) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					const content = await this.fileSystem.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					contents.set(filename, text);
				}
			}
		} catch {
			// Directory might not exist yet or other errors
		}
		return contents;
	}

	private hasContentChanged(oldContents: Map<string, string>, newContents: Map<string, string>): boolean {
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

	private generateInstructionMarkdown(instruction: CustomInstructionListItem): string {
		const frontmatterObj: Record<string, unknown> = {};

		if (instruction.display_name) {
			frontmatterObj.name = instruction.display_name;
		}
		if (instruction.description) {
			// Escape newlines in description to keep it on a single line
			frontmatterObj.description = instruction.description.replace(/\n/g, '\\n');
		}

		const frontmatter = YAML.stringify(frontmatterObj, { lineWidth: 0 }).trim();
		// Note: We don't have the prompt content from the list API, so we'll just use empty body
		// The actual prompt content would need to be fetched separately if needed
		const body = '';

		return `---\n${frontmatter}\n---\n${body}\n`;
	}

	private parseInstructionMetadata(content: string, filename: string): { name: string; description: string } | null {
		try {
			// Extract name from filename (e.g., "example.instruction.md" -> "example")
			const name = filename.replace(InstructionFileExtension, '');
			let description = '';

			// Look for frontmatter (YAML between --- markers) and extract description
			const lines = content.split('\n');
			if (lines[0]?.trim() === '---') {
				const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
				if (endIndex > 0) {
					const frontmatter = lines.slice(1, endIndex).join('\n');
					const descMatch = frontmatter.match(/description:\s*(.+)/);
					if (descMatch) {
						description = descMatch[1].trim();
					}
				}
			}

			return { name, description };
		} catch (error) {
			this.logService.error(`[OrganizationInstructionsProvider] Error parsing instruction metadata: ${error}`);
			return null;
		}
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
	}
}
