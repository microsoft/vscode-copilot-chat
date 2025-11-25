/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { GitHubMcpDefinitionProvider } from '../../../githubMcp/common/githubMcpDefinitionProvider';

declare const TextDecoder: {
	decode(input: Uint8Array): string;
	new(): TextDecoder;
};

// MCP Server Config types (not exported by @github/copilot/sdk)
interface MCPServerConfigBase {
	tools: string[];
	type?: string;
	isDefaultServer?: boolean;
}

interface MCPLocalServerConfig extends MCPServerConfigBase {
	type?: "local" | "stdio";
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface MCPRemoteServerConfig extends MCPServerConfigBase {
	type: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

export interface ICopilotCLIMCPHandler {
	readonly _serviceBrand: undefined;
	loadMcpConfig(workingDirectory: URI | undefined): Promise<Record<string, MCPServerConfig> | undefined>;
}

export const ICopilotCLIMCPHandler = createServiceIdentifier<ICopilotCLIMCPHandler>('ICopilotCLIMCPHandler');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const toStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((entry): entry is string => typeof entry === 'string');
	return strings.length ? strings : undefined;
};

const toStringRecord = (value: unknown): Record<string, string> | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value);
	if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) {
		return undefined;
	}
	return Object.fromEntries(entries) as Record<string, string>;
};

interface RawServerConfig {
	readonly type?: unknown;
	readonly command?: unknown;
	readonly args?: unknown;
	readonly tools?: unknown;
	readonly env?: unknown;
	readonly url?: unknown;
	readonly headers?: unknown;
	readonly cwd?: unknown;
}

export class CopilotCLIMCPHandler implements ICopilotCLIMCPHandler {
	declare _serviceBrand: undefined;
	constructor(
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	public async loadMcpConfig(workingDirectory: URI | undefined): Promise<Record<string, MCPServerConfig> | undefined> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLIMCPServerEnabled)) {
			return undefined;
		}

		const processedConfig: Record<string, MCPServerConfig> = {};

		const workspaceFolder = this.getWorkspaceFolder(workingDirectory);
		if (workspaceFolder) {
			await this.loadConfigFromWorkspace(workspaceFolder, processedConfig);
		}

		await this.addBuiltInGitHubServer(processedConfig);

		return Object.keys(processedConfig).length > 0 ? processedConfig : undefined;
	}

	private getWorkspaceFolder(workingDirectory: URI | undefined): URI | undefined {
		// If a working directory is provided, try to find the matching workspace folder
		if (workingDirectory) {
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			const matchingFolder = this.workspaceService.getWorkspaceFolder(workingDirectory) ?? workspaceFolders.find(folder => workingDirectory.fsPath.startsWith(folder.fsPath));
			if (matchingFolder) {
				return matchingFolder;
			}
			// If no matching workspace folder, use the working directory as a URI
			return workingDirectory;
		}

		// Fall back to the first workspace folder
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			this.logService.trace('[CopilotCLIMCPHandler] No workspace folders found.');
			return undefined;
		}
		return workspaceFolders[0];
	}

	private async loadConfigFromWorkspace(workspaceFolder: URI, processedConfig: Record<string, MCPServerConfig>): Promise<void> {
		const mcpConfigPath = joinPath(workspaceFolder, '.vscode', 'mcp.json');

		try {
			const fileContent = await this.workspaceService.fs.readFile(mcpConfigPath);
			const configText = new TextDecoder().decode(fileContent);
			await this.parseAndProcessConfig(configText, workspaceFolder.fsPath, processedConfig);
		} catch (error) {
			this.logService.trace(`[CopilotCLIMCPHandler] Failed to load MCP config file: ${error}`);
		}
	}

	private async parseAndProcessConfig(configText: string, workspacePath: string, processedConfig: Record<string, MCPServerConfig>): Promise<void> {
		const parseErrors: ParseError[] = [];
		const mcpConfig = parse(configText, parseErrors, { allowTrailingComma: true, disallowComments: false }) as unknown;

		if (parseErrors.length > 0) {
			const { error: parseErrorCode } = parseErrors[0];
			const message = printParseErrorCode(parseErrorCode);
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to parse MCP config ${message}.`);
			return;
		}

		const servers = this.extractServersFromConfig(mcpConfig);
		if (!servers) {
			return;
		}

		this.processServerConfigs(servers, workspacePath, processedConfig);
	}

	private extractServersFromConfig(mcpConfig: unknown): Record<string, unknown> | undefined {
		if (!isRecord(mcpConfig)) {
			return undefined;
		}

		// Try direct 'servers' property
		if (isRecord(mcpConfig['servers'])) {
			return mcpConfig['servers'];
		}

		// Try nested 'mcp.servers' property
		const mcpWrapper = mcpConfig['mcp'];
		if (isRecord(mcpWrapper) && isRecord(mcpWrapper['servers'])) {
			return mcpWrapper['servers'];
		}

		// Try 'mcpServers' property
		if (isRecord(mcpConfig['mcpServers'])) {
			return mcpConfig['mcpServers'];
		}

		return undefined;
	}

	private processServerConfigs(servers: Record<string, unknown>, workspacePath: string, processedConfig: Record<string, MCPServerConfig>): void {
		for (const [serverName, serverConfig] of Object.entries(servers)) {
			if (!isRecord(serverConfig)) {
				this.logService.warn(`[CopilotCLIMCPHandler] Ignoring invalid MCP server definition "${serverName}".`);
				continue;
			}

			const processedServer = this.processServerConfig(serverConfig as RawServerConfig, serverName, workspacePath);
			if (processedServer) {
				processedConfig[serverName] = processedServer;
			}
		}
	}

	private processServerConfig(rawConfig: RawServerConfig, serverName: string, workspacePath: string): MCPServerConfig | undefined {
		const type = typeof rawConfig.type === 'string' ? rawConfig.type : undefined;
		const toolsArray = toStringArray(rawConfig.tools);
		const tools = toolsArray && toolsArray.length > 0 ? toolsArray : ['*'];

		if (!type || type === 'local' || type === 'stdio') {
			return this.processLocalServerConfig(rawConfig, serverName, tools, workspacePath);
		}

		if (type === 'http' || type === 'sse') {
			return this.processRemoteServerConfig(rawConfig, serverName, type, tools);
		}

		this.logService.warn(`[CopilotCLIMCPHandler] Unsupported MCP server type "${type}" for "${serverName}".`);
		return undefined;
	}

	private processLocalServerConfig(rawConfig: RawServerConfig, serverName: string, tools: string[], workspacePath: string): MCPLocalServerConfig | undefined {
		const command = typeof rawConfig.command === 'string' ? rawConfig.command : undefined;
		if (!command) {
			this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP local server "${serverName}" due to missing command.`);
			return undefined;
		}

		const type = typeof rawConfig.type === 'string' && rawConfig.type === 'stdio' ? 'stdio' : 'local';
		const args = toStringArray(rawConfig.args) ?? [];
		const env = toStringRecord(rawConfig.env) ?? {};
		const cwd = typeof rawConfig.cwd === 'string' ? rawConfig.cwd.replace('${workspaceFolder}', workspacePath) : undefined;

		const localConfig: MCPLocalServerConfig = { type, command, args, tools, env };
		if (cwd) {
			localConfig.cwd = cwd;
		}
		return localConfig;
	}

	private processRemoteServerConfig(rawConfig: RawServerConfig, serverName: string, type: 'http' | 'sse', tools: string[]): MCPRemoteServerConfig | undefined {
		const url = typeof rawConfig.url === 'string' ? rawConfig.url : undefined;
		if (!url) {
			this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP remote server "${serverName}" due to missing url.`);
			return undefined;
		}

		const headers = toStringRecord(rawConfig.headers) ?? {};
		return { type, url, headers, tools };
	}

	private async addBuiltInGitHubServer(config: Record<string, MCPServerConfig>): Promise<void> {
		try {
			// Don't override if user has configured their own github mcp server
			if (config['github']) {
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

			config['github'] = {
				type: 'http',
				url: resolvedDefinition.uri.toString(),
				tools: ['*'],
				isDefaultServer: true,
				headers: resolvedDefinition.headers,
			};
			this.logService.trace('[CopilotCLIMCPHandler] Added built-in GitHub MCP server via definition provider.');
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to add built-in GitHub MCP server: ${error}`);
		}
	}
}