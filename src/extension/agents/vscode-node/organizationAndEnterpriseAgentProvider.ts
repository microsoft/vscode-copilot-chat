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
import { CustomAgentDetails, CustomAgentListOptions, IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { getRepoId } from '../../chatSessions/vscode/copilotCodingAgentUtils';

const AgentFileExtension = '.agent.md';

export class OrganizationAndEnterpriseAgentProvider extends Disposable implements vscode.CustomAgentsProvider {

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

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
		return vscode.Uri.joinPath(this.extensionContext.storageUri, 'githubAgentsCache');
	}

	async provideCustomAgents(
		options: vscode.CustomAgentQueryOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.CustomAgentResource[]> {
		try {
			// Get repository information from the active git repository
			const repoId = await getRepoId(this.gitService);
			if (!repoId) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No active repository found');
				return [];
			}

			const repoOwner = repoId.org;
			const repoName = repoId.repo;

			// Read from cache first
			const cachedAgents = await this.readFromCache(repoOwner, repoName);

			// Trigger async fetch to update cache
			this.fetchAndUpdateCache(repoOwner, repoName, options).catch(error => {
				this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error in background fetch: ${error}`);
			});

			return cachedAgents;
		} catch (error) {
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error in provideCustomAgents: ${error}`);
			return [];
		}
	}

	private async readFromCache(
		repoOwner: string,
		repoName: string,
	): Promise<vscode.CustomAgentResource[]> {
		try {
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No workspace open, cannot use cache');
				return [];
			}

			const cacheContents = await this.readCacheContents(cacheDir);
			if (cacheContents.size === 0) {
				this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] No cache found for ${repoOwner}/${repoName}`);
				return [];
			}

			const agents: vscode.CustomAgentResource[] = [];

			for (const [filename, text] of cacheContents) {
				// Parse metadata from the file (name and description)
				const metadata = this.parseAgentMetadata(text, filename);
				if (metadata) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					agents.push({
						name: metadata.name,
						description: metadata.description,
						uri: fileUri,
					});
				}
			}

			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Loaded ${agents.length} agents/prompts from cache for ${repoOwner}/${repoName}`);
			return agents;
		} catch (error) {
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async fetchAndUpdateCache(
		repoOwner: string,
		repoName: string,
		options: vscode.CustomAgentQueryOptions
	): Promise<void> {
		// Prevent concurrent fetches
		if (this.isFetching) {
			this.logService.trace('[OrganizationAndEnterpriseAgentProvider] Fetch already in progress, skipping');
			return;
		}

		this.isFetching = true;
		try {
			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Fetching custom agents for ${repoOwner}/${repoName}`);

			// Convert VS Code API options to internal options
			const internalOptions = options ? {
				target: options.target,
				includeSources: ['org', 'enterprise'] // don't include 'repo' to avoid redundancy
			} satisfies CustomAgentListOptions : undefined;

			const agents = await this.octoKitService.getCustomAgents(repoOwner, repoName, internalOptions);
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No workspace open, cannot use cache');
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
			for (const agent of agents) {
				const filename = this.sanitizeFilename(agent.name) + AgentFileExtension;

				// Fetch full agent details including prompt content
				const agentDetails = await this.octoKitService.getCustomAgentDetails(
					agent.repo_owner,
					agent.repo_name,
					agent.name,
					agent.version
				);

				// Generate agent markdown file content
				if (agentDetails) {
					const content = this.generateAgentMarkdown(agentDetails);
					newContents.set(filename, content);
				}
			}

			// Compare contents to detect changes
			const hasChanges = this.hasContentChanged(existingContents, newContents);

			if (!hasChanges) {
				this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] No changes detected in cache for ${repoOwner}/${repoName}`);
				return;
			}

			// Clear existing cache files
			const existingFiles = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of existingFiles) {
				if (fileType === FileType.File && filename.endsWith(AgentFileExtension)) {
					await this.fileSystem.delete(vscode.Uri.joinPath(cacheDir, filename));
				}
			}

			// Write new cache files
			for (const [filename, content] of newContents) {
				const fileUri = vscode.Uri.joinPath(cacheDir, filename);
				await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(content));
			}

			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Updated cache with ${agents.length} agents for ${repoOwner}/${repoName}`);

			// Fire event to notify consumers that agents have changed
			this._onDidChangeCustomAgents.fire();
		} finally {
			this.isFetching = false;
		}
	}

	private async readCacheContents(cacheDir: vscode.Uri): Promise<Map<string, string>> {
		const contents = new Map<string, string>();
		try {
			const files = await this.fileSystem.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === FileType.File && filename.endsWith(AgentFileExtension)) {
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

	private generateAgentMarkdown(agent: CustomAgentDetails): string {
		const frontmatterObj: Record<string, unknown> = {};

		if (agent.display_name) {
			frontmatterObj.name = agent.display_name;
		}
		if (agent.description) {
			frontmatterObj.description = agent.description;
		}
		if (agent.tools && agent.tools.length > 0 && agent.tools[0] !== '*') {
			frontmatterObj.tools = agent.tools;
		}
		if (agent.argument_hint) {
			frontmatterObj['argument-hint'] = agent.argument_hint;
		}
		if (agent.target) {
			frontmatterObj.target = agent.target;
		}

		const frontmatter = YAML.stringify(frontmatterObj, { lineWidth: 0 }).trim();
		const body = agent.prompt ?? '';

		return `---\n${frontmatter}\n---\n${body}\n`;
	}

	private parseAgentMetadata(content: string, filename: string): { name: string; description: string } | null {
		try {
			// Extract name from filename (e.g., "example.agent.md" -> "example")
			const name = filename.replace(AgentFileExtension, '');
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
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error parsing agent metadata: ${error}`);
			return null;
		}
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
	}
}
