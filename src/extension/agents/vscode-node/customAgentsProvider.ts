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

export class CustomAgentsProvider extends Disposable implements vscode.CustomAgentsProvider {

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	private readonly cacheDir: vscode.Uri;
	private isFetching = false;

	constructor(
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this.cacheDir = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'customAgents');
	}

	async provideCustomAgents(
		options: vscode.CustomAgentQueryOptions | undefined,
		token: vscode.CancellationToken
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

			// Trigger async fetch to update cache (don't await)
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
			const repoCacheDir = this.getRepoCacheDir(repoOwner, repoName);

			// Check if cache directory exists
			try {
				await vscode.workspace.fs.stat(repoCacheDir);
			} catch {
				// Cache doesn't exist yet
				this.logService.trace(`[CustomAgentsProvider] No cache found for ${repoOwner}/${repoName}`);
				return [];
			}

			// Read all .agent.md and .prompt.md files from cache
			const files = await vscode.workspace.fs.readDirectory(repoCacheDir);
			const agents: vscode.CustomAgentResource[] = [];

			for (const [filename, fileType] of files) {
				if (fileType === vscode.FileType.File && (filename.endsWith('.agent.md') || filename.endsWith('.prompt.md'))) {
					const fileUri = vscode.Uri.joinPath(repoCacheDir, filename);
					const content = await vscode.workspace.fs.readFile(fileUri);
					const text = new TextDecoder().decode(content);

					// Parse metadata from the file (name and description)
					const metadata = this.parseAgentMetadata(text, filename);
					if (metadata) {
						agents.push({
							name: metadata.name,
							description: metadata.description,
							uri: fileUri,
						});
					}
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

			// Fetch agents and org custom instructions in parallel
			const [agents, orgInstructions] = await Promise.all([
				this.octoKitService.getCustomAgents(repoOwner, repoName, internalOptions),
				this.octoKitService.getOrgCustomInstructions(repoOwner, repoName).catch(error => {
					this.logService.error(`[CustomAgentsProvider] Error fetching org custom instructions: ${error}`);
					return null;
				})
			]);

			// Update cache
			const repoCacheDir = this.getRepoCacheDir(repoOwner, repoName);

			// Ensure cache directory exists
			try {
				await vscode.workspace.fs.stat(repoCacheDir);
			} catch (error) {
				// Directory doesn't exist, create it
				await vscode.workspace.fs.createDirectory(repoCacheDir);
			}

			// Clear existing cache files
			try {
				const existingFiles = await vscode.workspace.fs.readDirectory(repoCacheDir);
				for (const [filename] of existingFiles) {
					await vscode.workspace.fs.delete(vscode.Uri.joinPath(repoCacheDir, filename));
				}
			} catch {
				// Directory might not exist yet
			}

			// Write new cache files for custom agents
			for (const agent of agents) {
				const filename = this.sanitizeFilename(agent.name) + '.agent.md';
				const fileUri = vscode.Uri.joinPath(repoCacheDir, filename);

				// Fetch full agent details including prompt content
				const agentDetails = await this.octoKitService.getCustomAgentDetails(
					agent.repo_owner,
					agent.repo_name,
					agent.name,
					agent.version
				);

				// Generate agent markdown file content
				const content = this.generateAgentMarkdown(agentDetails || agent);
				await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
			}

			// Write cache files for org custom instructions (prompts)
			if (orgInstructions?.prompts && Array.isArray(orgInstructions.prompts)) {
				for (const prompt of orgInstructions.prompts) {
					const filename = this.sanitizeFilename(prompt.name) + '.prompt.md';
					const fileUri = vscode.Uri.joinPath(repoCacheDir, filename);

					// Generate prompt markdown file content
					const content = this.generatePromptMarkdown(prompt);
					await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
				}

				this.logService.trace(`[CustomAgentsProvider] Cached ${orgInstructions.prompts.length} custom instructions`);
			}

			this.logService.trace(`[CustomAgentsProvider] Updated cache with ${agents.length} agents for ${repoOwner}/${repoName}`);

			// Fire event to notify consumers that agents have changed
			this._onDidChangeCustomAgents.fire();
		} finally {
			this.isFetching = false;
		}
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
			let name = filename.replace('.agent.md', '').replace('.prompt.md', '');
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

	private getRepoCacheDir(repoOwner: string, repoName: string): vscode.Uri {
		return vscode.Uri.joinPath(this.cacheDir, `${repoOwner}_${repoName}`);
	}

	private generatePromptMarkdown(prompt: {
		name: string;
		description?: string;
		content: string;
		metadata?: Record<string, string>;
	}): string {
		const lines: string[] = [];

		// Add header with metadata
		lines.push(`---`);
		lines.push(`name: ${prompt.name}`);
		if (prompt.description) {
			lines.push(`description: ${prompt.description}`);
		}
		if (prompt.metadata) {
			lines.push(`metadata:`);
			for (const [key, value] of Object.entries(prompt.metadata)) {
				lines.push(`  ${key}: ${value}`);
			}
		}
		lines.push(`---`);
		lines.push(``);

		// Add body
		lines.push(`# ${prompt.name}`);
		lines.push(``);
		if (prompt.description) {
			lines.push(prompt.description);
			lines.push(``);
		}
		lines.push(prompt.content);

		return lines.join('\n');
	}
}
