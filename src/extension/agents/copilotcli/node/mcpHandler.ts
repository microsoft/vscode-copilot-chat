/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session } from '@github/copilot/sdk';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IMcpService } from '../../../../platform/mcp/common/mcpService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { McpHttpServerDefinition, McpStdioServerDefinition } from '../../../../vscodeTypes';
import { GitHubMcpDefinitionProvider } from '../../../githubMcp/common/githubMcpDefinitionProvider';

const toolInvalidCharRe = /[^a-z0-9_-]/gi;

export type MCPServerConfig = NonNullable<Session['mcpServers']>[string];

export interface ICopilotCLIMCPHandler {
	readonly _serviceBrand: undefined;
	loadMcpConfig(): Promise<Record<string, MCPServerConfig> | undefined>;
}

export const ICopilotCLIMCPHandler = createServiceIdentifier<ICopilotCLIMCPHandler>('ICopilotCLIMCPHandler');

export class CopilotCLIMCPHandler implements ICopilotCLIMCPHandler {
	declare _serviceBrand: undefined;
	constructor(
		@ILogService private readonly logService: ILogService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMcpService private readonly mcpService: IMcpService,
	) { }

	public async loadMcpConfig(): Promise<Record<string, MCPServerConfig> | undefined> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLIMCPServerEnabled)) {
			return undefined;
		}

		const processedConfig: Record<string, MCPServerConfig> = {};
		this.mcpService.mcpServerDefinitions.forEach(definition => {
			if (definition instanceof McpStdioServerDefinition) {
				const localConfig = this.processLocalServerConfig(definition);
				if (localConfig) {
					const id = this.generateUniqueServerId(definition.label, processedConfig);
					if (id) {
						processedConfig[id] = localConfig;
					}
				}
			} else {
				const remoteConfig = this.processRemoteServerConfig(definition);
				if (remoteConfig) {
					const id = this.generateUniqueServerId(definition.label, processedConfig);
					if (id) {
						processedConfig[id] = remoteConfig;
					}
				}
			}
		});

		await this.addBuiltInGitHubServer(processedConfig);

		return Object.keys(processedConfig).length > 0 ? processedConfig : undefined;
	}

	private normalizeServerName(originalName: string): string | undefined {
		// Convert to lowercase and replace invalid characters with underscore
		let normalized = originalName.toLowerCase().replace(toolInvalidCharRe, '_');

		// Trim leading and trailing underscores
		normalized = normalized.replace(/^_+|_+$/g, '');

		// Return undefined if normalization results in empty string
		if (!normalized) {
			this.logService.error(`[CopilotCLIMCPHandler] Failed to normalize server name '${originalName}' - result is empty`);
			return undefined;
		}

		if (normalized !== originalName) {
			this.logService.trace(`[CopilotCLIMCPHandler] Normalized server '${originalName}' to '${normalized}'`);
		}

		return normalized;
	}

	private generateUniqueServerId(label: string, existingConfig: Record<string, MCPServerConfig>): string | undefined {
		const baseId = this.normalizeServerName(label);

		// Return undefined if normalization failed
		if (!baseId) {
			return undefined;
		}

		// If no collision, use the base ID
		if (!(baseId in existingConfig)) {
			return baseId;
		}

		// Handle collision by appending normalized UUID
		const uuid = generateUuid();
		const normalizedUuid = uuid.toLowerCase().replace(/-/g, '').substring(0, 8);
		const uniqueId = `${baseId}_${normalizedUuid}`;

		this.logService.trace(`[CopilotCLIMCPHandler] Generated unique ID '${uniqueId}' for server '${label}' due to collision`);

		return uniqueId;
	}

	private processLocalServerConfig(def: McpStdioServerDefinition): MCPServerConfig | undefined {
		const serverName = def.label;
		const command = def.command;
		if (!command) {
			this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP local server "${serverName}" due to missing command.`);
			return undefined;
		}

		const args = def.args;
		const env = Object.fromEntries(Object.entries(def.env).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, String(value)]));
		const cwd = def.cwd?.fsPath;

		return { type: 'stdio', command, args, env, cwd, tools: ['*'], displayName: def.label };
	}

	private processRemoteServerConfig(def: McpHttpServerDefinition): MCPServerConfig | undefined {
		const url = def.uri.toString();

		const headers = def.headers;

		return { type: 'http', url, headers, tools: ['*'], displayName: def.label };
	}

	private async addBuiltInGitHubServer(config: Record<string, MCPServerConfig>): Promise<void> {
		try {
			const possibleKeys = ['github', 'io_github_github_github-mcp-server'];
			const githubConfigKey = Object.keys(config).find(key => possibleKeys.includes(key));
			const githubConfig = githubConfigKey ? config[githubConfigKey] : undefined;
			if (!githubConfig || !githubConfigKey) {
				return;
			}

			// Override only if no GitHub MCP server is already configured
			if (githubConfig.type !== 'http') {
				return;
			}
			// We have headers, do not override
			if (Object.keys(githubConfig.headers || {}).length > 0) {
				return;
			}

			const definitionProvider = new GitHubMcpDefinitionProvider(
				this.configurationService,
				this.authenticationService,
				this.logService
			);

			const definitions = definitionProvider.provideMcpServerDefinitions();
			if (!definitions || definitions.length === 0) {
				this.logService.trace('[CopilotCLIMCPHandler] No GitHub MCP server definitions available.');
				return;
			}

			// Use the first definition
			const definition = definitions[0];

			// Resolve the definition to get the access token
			const resolvedDefinition = await definitionProvider.resolveMcpServerDefinition(definition, {} as CancellationToken);

			config[githubConfigKey] = {
				type: 'http',
				url: githubConfig.url ?? resolvedDefinition.uri.toString(),
				isDefaultServer: true,
				headers: resolvedDefinition.headers,
				tools: githubConfig.tools.length ? githubConfig.tools : ['*'],
				displayName: githubConfig.displayName ?? 'GitHub',
			};
			this.logService.trace('[CopilotCLIMCPHandler] Added built-in GitHub MCP server via definition provider.');
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to add built-in GitHub MCP server: ${error}`);
		}
	}
}
