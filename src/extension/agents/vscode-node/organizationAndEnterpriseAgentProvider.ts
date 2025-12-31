/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import YAML from 'yaml';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, IOctoKitService, PermissiveAuthRequiredError } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const AgentFileExtension = '.agent.md';

export class OrganizationAndEnterpriseAgentProvider extends Disposable implements vscode.CustomAgentsProvider {

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	private isFetching = false;
	private memoryCache: vscode.CustomAgentResource[] | undefined;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
	) {
		super();

		// Trigger async fetch to update cache. Note: this provider is re-created each time
		// the user signs in, so this will re-fetch on sign-in. See logic in conversationFeature.ts.
		this.fetchAndUpdateCache().catch(error => {
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error in background fetch: ${error}`);
		});
	}

	private getCacheDir(): vscode.Uri {
		return vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'githubAgentsCache');
	}

	async provideCustomAgents(
		_options: vscode.CustomAgentQueryOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.CustomAgentResource[]> {
		try {
			if (this.memoryCache !== undefined) {
				return this.memoryCache;
			}

			// Return results from file cache
			return await this.readFromCache();
		} catch (error) {
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error in provideCustomAgents: ${error}`);
			return [];
		}
	}

	private async readFromCache(): Promise<vscode.CustomAgentResource[]> {
		try {
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No workspace open, cannot use cache');
				return [];
			}

			const agents: vscode.CustomAgentResource[] = [];

			// Check if cache directory exists
			try {
				await this.fileSystem.stat(cacheDir);
			} catch {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No cache found');
				return [];
			}

			// Read all org folders
			const entries = await this.fileSystem.readDirectory(cacheDir);
			for (const [entry, fileType] of entries) {
				if (fileType !== FileType.Directory) {
					continue;
				}

				const orgDir = vscode.Uri.joinPath(cacheDir, entry);
				const cacheContents = await this.readCacheContents(orgDir);

				for (const [filename, text] of cacheContents) {
					// Parse metadata from the file (name and description)
					const metadata = this.parseAgentMetadata(text, filename);
					if (metadata) {
						const fileUri = vscode.Uri.joinPath(orgDir, filename);
						agents.push({
							name: metadata.name,
							description: metadata.description,
							uri: fileUri,
						});
					}
				}
			}

			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Loaded ${agents.length} agents/prompts from cache`);
			return agents;
		} catch (error) {
			this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error reading from cache: ${error}`);
			return [];
		}
	}


	private async fetchAndUpdateCache(): Promise<void> {
		// Prevent concurrent fetches
		if (this.isFetching) {
			this.logService.trace('[OrganizationAndEnterpriseAgentProvider] Fetch already in progress, skipping');
			return;
		}

		this.isFetching = true;
		try {
			const user = await this.octoKitService.getCurrentAuthedUser();
			if (!user) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] User not signed in, skipping fetch');
				return;
			}

			this.logService.trace('[OrganizationAndEnterpriseAgentProvider] Fetching custom agents from all user organizations');

			// Get all organizations the user belongs to
			const organizations = await this.octoKitService.getUserOrganizations({ createIfNone: false });
			if (organizations.length === 0) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] User does not belong to any organizations');
				return;
			}

			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Found ${organizations.length} organizations: ${organizations.join(', ')}`);

			// Convert VS Code API options to internal options
			const internalOptions = {
				includeSources: ['org', 'enterprise'] // don't include 'repo'
			} satisfies CustomAgentListOptions;

			// Fetch agents from all organizations
			const agentsByOrg = new Map<string, Map<string, CustomAgentListItem>>();
			let hadAnyFetchErrors = false;

			// Track unique agents globally to dedupe enterprise agents that appear across multiple orgs
			const seenAgents = new Map<string, CustomAgentListItem>();

			for (const org of organizations) {
				try {
					const agentsForOrg = new Map<string, CustomAgentListItem>();
					agentsByOrg.set(org, agentsForOrg);

					// Get the first repository for this organization to use in the API call
					// We can't just use .github-private because user may not have access to it
					const repos = await this.octoKitService.getOrganizationRepositories(org, { createIfNone: false });
					if (repos.length === 0) {
						this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] No repositories found for ${org}, skipping`);
						continue;
					}

					const repoName = repos[0];
					const agents = await this.octoKitService.getCustomAgents(org, repoName, internalOptions, { createIfNone: false });
					for (const agent of agents) {
						// Create unique key to identify agents (enterprise agents may appear in multiple orgs)
						// Note: version is not included, so different versions are deduplicated
						const agentKey = `${agent.repo_owner}/${agent.repo_name}/${agent.name}`;

						// Skip if we've already seen this agent (dedupe enterprise agents)
						if (seenAgents.has(agentKey)) {
							continue;
						}

						seenAgents.set(agentKey, agent);
						agentsForOrg.set(agent.name, agent);
					}
					this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Fetched ${agents.length} agents from ${org} using repo ${repoName} (${agentsForOrg.size} added after deduplication)`);
				} catch (error) {
					if (error instanceof PermissiveAuthRequiredError) {
						this.logService.trace('[OrganizationAndEnterpriseAgentProvider] User signed out during fetch, aborting');
						return;
					}
					this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error fetching agents from ${org}: ${error}`);
					hadAnyFetchErrors = true;
				}
			}

			const cacheDir = this.getCacheDir();

			// Ensure cache directory exists
			try {
				await this.fileSystem.stat(cacheDir);
			} catch (error) {
				// Directory doesn't exist, create it
				await this.fileSystem.createDirectory(cacheDir);
			}

			let totalAgents = 0;
			let hasChanges = false;

			// Get list of currently cached organizations
			const cachedOrgDirs = new Set<string>();
			try {
				const entries = await this.fileSystem.readDirectory(cacheDir);
				for (const [entry, fileType] of entries) {
					if (fileType === FileType.Directory) {
						cachedOrgDirs.add(entry);
					}
				}
			} catch {
				// Cache directory might not exist yet
			}

			// Track which orgs we've successfully processed
			const processedOrgDirs = new Set<string>();

			// Process each organization
			for (const org of agentsByOrg.keys()) {
				const sanitizedOrgName = this.sanitizeFilename(org);
				const orgDir = vscode.Uri.joinPath(cacheDir, sanitizedOrgName);
				const orgAgents = agentsByOrg.get(org) || new Map();

				// Track that we're processing this org
				processedOrgDirs.add(sanitizedOrgName);

				// Ensure org directory exists
				try {
					await this.fileSystem.stat(orgDir);
				} catch (error) {
					await this.fileSystem.createDirectory(orgDir);
				}

				// Read existing cache contents for this org
				const existingContents = await this.readCacheContents(orgDir);

				// Generate new cache contents for this org
				const newContents = new Map<string, string>();
				let hadFetchError = false;
				for (const agent of orgAgents.values()) {
					try {
						const filename = this.sanitizeFilename(agent.name) + AgentFileExtension;

						// Fetch full agent details including prompt content
						const agentDetails = await this.octoKitService.getCustomAgentDetails(
							agent.repo_owner,
							agent.repo_name,
							agent.name,
							agent.version,
							{ createIfNone: false }
						);

						// Generate agent markdown file content
						if (agentDetails) {
							const content = this.generateAgentMarkdown(agentDetails);
							newContents.set(filename, content);
							totalAgents++;
						}
					} catch (error) {
						if (error instanceof PermissiveAuthRequiredError) {
							this.logService.trace('[OrganizationAndEnterpriseAgentProvider] User signed out during fetch, aborting');
							return;
						}
						this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error fetching details for agent ${agent.name} from ${org}: ${error}`);
						hadFetchError = true;
					}
				}

				// Skip cache update if we had any errors fetching agent details
				if (hadFetchError) {
					this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Skipping cache update for ${org} due to fetch errors`);
					hadAnyFetchErrors = true;
					continue;
				}

				// Compare contents to detect changes for this org
				const orgHasChanges = this.hasContentChanged(existingContents, newContents);

				if (orgHasChanges) {
					hasChanges = true;

					// Clear existing cache files for this org
					const existingFiles = await this.fileSystem.readDirectory(orgDir);
					for (const [filename, fileType] of existingFiles) {
						if (fileType === FileType.File && filename.endsWith(AgentFileExtension)) {
							await this.fileSystem.delete(vscode.Uri.joinPath(orgDir, filename));
						}
					}

					// Write new cache files for this org
					for (const [filename, content] of newContents) {
						const fileUri = vscode.Uri.joinPath(orgDir, filename);
						await this.fileSystem.writeFile(fileUri, new TextEncoder().encode(content));
					}
				}
			}

			// Delete cache directories for organizations the user no longer belongs to
			for (const cachedOrgDir of cachedOrgDirs) {
				if (!processedOrgDirs.has(cachedOrgDir)) {
					const orgDirToDelete = vscode.Uri.joinPath(cacheDir, cachedOrgDir);
					try {
						await this.fileSystem.delete(orgDirToDelete, { recursive: true, useTrash: false });
						this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Deleted cache for organization no longer accessible: ${cachedOrgDir}`);
						hasChanges = true;
					} catch (error) {
						this.logService.error(`[OrganizationAndEnterpriseAgentProvider] Error deleting cache directory ${cachedOrgDir}: ${error}`);
					}
				}
			}

			this.logService.trace(`[OrganizationAndEnterpriseAgentProvider] Updated cache with ${totalAgents} agents from ${organizations.length} organizations`);

			// If all fetch operations succeeded, populate memory cache
			if (!hadAnyFetchErrors && this.memoryCache === undefined) {
				this.memoryCache = await this.readFromCache();
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] Successfully populated memory cache');
			}

			if (!hasChanges) {
				this.logService.trace('[OrganizationAndEnterpriseAgentProvider] No changes detected in cache');
				return;
			}

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
			// Escape newlines in description to keep it on a single line
			frontmatterObj.description = agent.description.replace(/\n/g, '\\n');
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
		if (agent.model) {
			frontmatterObj.model = agent.model;
		}
		if (agent.infer) {
			frontmatterObj.infer = agent.infer;
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
