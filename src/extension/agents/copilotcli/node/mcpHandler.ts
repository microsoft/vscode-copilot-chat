/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IMcpService } from '../../../../platform/mcp/common/mcpService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { McpHttpServerDefinition, McpStdioServerDefinition } from '../../../../vscodeTypes';
import { GitHubMcpDefinitionProvider } from '../../../githubMcp/common/githubMcpDefinitionProvider';


// MCP Server Config types (not exported by @github/copilot/sdk)
interface MCPServerConfigBase {
	tools: string[];
	type?: string;
	isDefaultServer?: boolean;
}

interface MCPLocalServerConfig extends MCPServerConfigBase {
	type?: 'stdio';
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface MCPRemoteServerConfig extends MCPServerConfigBase {
	type: 'http' | 'sse';
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

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
					const id = processedConfig[definition.label] ? `${definition.label}-${generateUuid()}` : definition.label;
					processedConfig[id] = localConfig;
				}
			} else {
				const remoteConfig = this.processRemoteServerConfig(definition);
				if (remoteConfig) {
					const id = processedConfig[definition.label] ? `${definition.label}-${generateUuid()}` : definition.label;
					processedConfig[id] = remoteConfig;
				}
			}
		});

		await this.addBuiltInGitHubServer(processedConfig);

		return Object.keys(processedConfig).length > 0 ? processedConfig : undefined;
	}


	private processLocalServerConfig(def: McpStdioServerDefinition): MCPLocalServerConfig | undefined {
		const serverName = def.label;
		const command = def.command;
		if (!command) {
			this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP local server "${serverName}" due to missing command.`);
			return undefined;
		}

		const args = def.args;
		const env = Object.fromEntries(Object.entries(def.env).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, String(value)]));
		const cwd = def.cwd?.fsPath;

		return { type: 'stdio', command, args, env, cwd, tools: ['*'] };
	}

	private processRemoteServerConfig(def: McpHttpServerDefinition): MCPRemoteServerConfig | undefined {
		const url = def.uri.toString();

		const headers = def.headers;

		return { type: 'http', url, headers, tools: ['*'] };
	}

	private async addBuiltInGitHubServer(config: Record<string, MCPServerConfig>): Promise<void> {
		try {
			// Override only if no GitHub MCP server is already configured
			if (config['github'] && config['github'].type === 'http') {
				// We have headers, do not override
				if (Object.keys(config['github'].headers || {}).length > 0) {
					return;
				}
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

			config['github'] = {
				type: 'http',
				url: resolvedDefinition.uri.toString(),
				isDefaultServer: true,
				headers: resolvedDefinition.headers,
				tools: ['*']
			};
			this.logService.trace('[CopilotCLIMCPHandler] Added built-in GitHub MCP server via definition provider.');
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to add built-in GitHub MCP server: ${error}`);
		}
	}
}
