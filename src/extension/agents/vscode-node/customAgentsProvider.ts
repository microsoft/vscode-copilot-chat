/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { getRepoId } from '../../chatSessions/vscode/copilotCodingAgentUtils';

const AgentFileExtension = '.agent.md';

export class CustomAgentsProvider extends Disposable implements vscode.CustomAgentsProvider {

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	private isFetching = false;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
	}

	private getCacheDir(): vscode.Uri | undefined {
		if (!this.extensionContext.storageUri) {
			return;
		}
		return vscode.Uri.joinPath(this.extensionContext.storageUri, 'customAgentsCache');
	}

	async provideCustomAgents(
		options: vscode.CustomAgentQueryOptions | undefined,
		_token: vscode.CancellationToken
	): Promise<vscode.CustomAgentResource[]> {
		try {
			// Get repository information from the active git repository
			const repoId = await getRepoId(this.gitService);
			if (!repoId) {
				this.logService.trace('[CustomAgentsProvider] No active repository found');
				return [];
			}

			const repoOwner = repoId.org;
			const repoName = repoId.repo;

			// Read from cache first
			const cachedAgents = await this.readFromCache(repoOwner, repoName);

			// Trigger async fetch to update cache
			this.fetchAndUpdateCache(repoOwner, repoName, options).catch(error => {
				this.logService.error(`[CustomAgentsProvider] Error in background fetch: ${error}`);
			});

			return cachedAgents;
		} catch (error) {
			this.logService.error(`[CustomAgentsProvider] Error in provideCustomAgents: ${error}`);
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
				this.logService.trace('[CustomAgentsProvider] No workspace open, cannot use cache');
				return [];
			}

			const cacheContents = await this.readCacheContents(cacheDir);
			if (cacheContents.size === 0) {
				this.logService.trace(`[CustomAgentsProvider] No cache found for ${repoOwner}/${repoName}`);
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

			this.logService.trace(`[CustomAgentsProvider] Loaded ${agents.length} agents/prompts from cache for ${repoOwner}/${repoName}`);
			return agents;
		} catch (error) {
			this.logService.error(`[CustomAgentsProvider] Error reading from cache: ${error}`);
			return [];
		}
	}

	private async fetchAndUpdateCache(
		repoOwner: string,
		repoName: string,
		options: vscode.CustomAgentQueryOptions | undefined
	): Promise<void> {
		// Prevent concurrent fetches
		if (this.isFetching) {
			this.logService.trace('[CustomAgentsProvider] Fetch already in progress, skipping');
			return;
		}

		this.isFetching = true;
		try {
			this.logService.trace(`[CustomAgentsProvider] Fetching custom agents for ${repoOwner}/${repoName}`);

			// Convert VS Code API options to internal options
			const internalOptions = options ? {
				target: options.target,
				includeSources: ['org', 'enterprise'] // don't include 'repo' to avoid redundancy
			} satisfies CustomAgentListOptions : undefined;

			const agents = await this.octoKitService.getCustomAgents(repoOwner, repoName, internalOptions);
			const cacheDir = this.getCacheDir();
			if (!cacheDir) {
				this.logService.trace('[CustomAgentsProvider] No workspace open, cannot use cache');
				return;
			}

			// Ensure cache directory exists
			try {
				await vscode.workspace.fs.stat(cacheDir);
			} catch (error) {
				// Directory doesn't exist, create it
				await vscode.workspace.fs.createDirectory(cacheDir);
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
				this.logService.trace(`[CustomAgentsProvider] No changes detected in cache for ${repoOwner}/${repoName}`);
				return;
			}

			// Clear existing cache files
			const existingFiles = await vscode.workspace.fs.readDirectory(cacheDir);
			for (const [filename, fileType] of existingFiles) {
				if (fileType === vscode.FileType.File && filename.endsWith(AgentFileExtension)) {
					await vscode.workspace.fs.delete(vscode.Uri.joinPath(cacheDir, filename));
				}
			}

			// Write new cache files
			for (const [filename, content] of newContents) {
				const fileUri = vscode.Uri.joinPath(cacheDir, filename);
				await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
			}

			this.logService.trace(`[CustomAgentsProvider] Updated cache with ${agents.length} agents for ${repoOwner}/${repoName}`);

			// Fire event to notify consumers that agents have changed
			this._onDidChangeCustomAgents.fire();
		} finally {
			this.isFetching = false;
		}
	}

	private async readCacheContents(cacheDir: vscode.Uri): Promise<Map<string, string>> {
		const contents = new Map<string, string>();
		try {
			const files = await vscode.workspace.fs.readDirectory(cacheDir);
			for (const [filename, fileType] of files) {
				if (fileType === vscode.FileType.File && filename.endsWith(AgentFileExtension)) {
					const fileUri = vscode.Uri.joinPath(cacheDir, filename);
					const content = await vscode.workspace.fs.readFile(fileUri);
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

	private generateAgentMarkdown(agent: CustomAgentDetails | CustomAgentListItem): string {
		// Generate agent.md file content from CustomAgent metadata
		const lines: string[] = [];

		// Add header with metadata
		lines.push(`---`);
		lines.push(`name: ${agent.name}`);
		if (agent.display_name) {
			lines.push(`displayName: ${agent.display_name}`);
		}
		if (agent.description) {
			lines.push(`description: ${agent.description}`);
		}
		if (agent.tools && agent.tools.length > 0) {
			lines.push(`tools: [${agent.tools.join(', ')}]`);
		}
		if (agent.argument_hint) {
			lines.push(`argumentHint: ${agent.argument_hint}`);
		}
		if (agent.target) {
			lines.push(`target: ${agent.target}`);
		}
		if (agent.metadata) {
			lines.push(`advancedOptions:`);
			for (const [key, value] of Object.entries(agent.metadata)) {
				lines.push(`  ${key}: ${value}`);
			}
		}
		if (agent['mcp-servers']) {
			lines.push(`mcp-servers:`);
			for (const [serverName, serverConfig] of Object.entries(agent['mcp-servers'])) {
				lines.push(`  ${serverName}:`);
				for (const [key, value] of Object.entries(serverConfig)) {
					if (Array.isArray(value)) {
						lines.push(`    ${key}: [${value.join(', ')}]`);
					} else if (typeof value === 'object' && value !== null) {
						lines.push(`    ${key}:`);
						for (const [k, v] of Object.entries(value)) {
							lines.push(`      ${k}: ${v}`);
						}
					} else {
						lines.push(`    ${key}: ${value}`);
					}
				}
			}
		}
		lines.push(`---`);
		lines.push(``);

		// Add body (prompt instructions if available)
		lines.push(`# ${agent.display_name || agent.name}`);
		lines.push(``);
		if (agent.description) {
			lines.push(agent.description);
			lines.push(``);
		}

		// Add prompt content if available (from CustomAgentDetails)
		if ('prompt' in agent && agent.prompt) {
			lines.push(agent.prompt);
		} else {
			lines.push(`This is a custom agent.`);
		}

		return lines.join('\n');
	}

	private parseAgentMetadata(content: string, filename: string): { name: string; description: string } | null {
		try {
			// Parse frontmatter or extract metadata from the content
			// For now, use a simple approach: extract from first heading and paragraph
			const lines = content.split('\n');
			let name = filename.replace(AgentFileExtension, '');
			let description = '';

			// Look for frontmatter (YAML between --- markers)
			if (lines[0]?.trim() === '---') {
				const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
				if (endIndex > 0) {
					const frontmatter = lines.slice(1, endIndex).join('\n');
					const nameMatch = frontmatter.match(/name:\s*(.+)/);
					const descMatch = frontmatter.match(/description:\s*(.+)/);
					if (nameMatch) {
						name = nameMatch[1].trim();
					}
					if (descMatch) {
						description = descMatch[1].trim();
					}
					return { name, description };
				}
			}

			// Fallback: look for first # heading and first paragraph
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith('# ') && !name) {
					name = trimmed.substring(2).trim();
				} else if (trimmed && !trimmed.startsWith('#') && !description) {
					description = trimmed;
					break;
				}
			}

			return { name, description };
		} catch (error) {
			this.logService.error(`[CustomAgentsProvider] Error parsing agent metadata: ${error}`);
			return null;
		}
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
	}
}
