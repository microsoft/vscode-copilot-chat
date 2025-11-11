/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { joinPath } from '../../../../util/vs/base/common/resources';

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
	loadMcpConfig(workingDirectory: string | undefined): Promise<Record<string, MCPServerConfig> | undefined>;
}

export const ICopilotCLIMCPHandler = createServiceIdentifier<ICopilotCLIMCPHandler>('ICopilotCLIMCPHandler');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const toStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((entry): entry is string => typeof entry === 'string');
	return strings.length ? strings : [];
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
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) { }

	public async loadMcpConfig(_workingDirectory: string | undefined): Promise<Record<string, MCPServerConfig> | undefined> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (workspaceFolders.length === 0) {
				return undefined;
			}

			const workspaceFolder = workspaceFolders[0];
			const mcpConfigPath = joinPath(workspaceFolder, '.vscode', 'mcp.json');

			const fileContent = await this.workspaceService.fs.readFile(mcpConfigPath);
			const configText = new TextDecoder().decode(fileContent);

			const parseErrors: ParseError[] = [];
			const mcpConfig = parse(configText, parseErrors, { allowTrailingComma: true, disallowComments: false }) as unknown;
			if (parseErrors.length > 0) {
				const { error: parseErrorCode } = parseErrors[0];
				const message = printParseErrorCode(parseErrorCode);
				this.logService.warn(`[CopilotCLIMCPHandler] Failed to parse MCP config ${message}.`);
				return undefined;
			}

			const processedConfig: Record<string, MCPServerConfig> = {};

			let servers: Record<string, unknown> | undefined;
			if (isRecord(mcpConfig)) {
				const maybeServers = mcpConfig['servers'];
				if (isRecord(maybeServers)) {
					servers = maybeServers;
				}

				if (!servers) {
					const maybeMcpWrapper = isRecord(mcpConfig['mcp']) ? mcpConfig['mcp'] : undefined;
					if (maybeMcpWrapper) {
						const wrappedServers = maybeMcpWrapper['servers'];
						if (isRecord(wrappedServers)) {
							servers = wrappedServers;
						}
					}
				}

				if (!servers) {
					const maybeMcpServers = mcpConfig['mcpServers'];
					if (isRecord(maybeMcpServers)) {
						servers = maybeMcpServers;
					}
				}
			}

			if (servers) {
				for (const [serverName, serverConfig] of Object.entries(servers)) {
					if (!isRecord(serverConfig)) {
						this.logService.warn(`[CopilotCLIMCPHandler] Ignoring invalid MCP server definition "${serverName}".`);
						continue;
					}

					const rawConfig = serverConfig as RawServerConfig;
					const type = typeof rawConfig.type === 'string' ? rawConfig.type : undefined;
					const toolsArray = toStringArray(rawConfig.tools);
					const tools = toolsArray && toolsArray.length > 0 ? toolsArray : ['*'];
					const args = toStringArray(rawConfig.args) ?? [];
					const env = toStringRecord(rawConfig.env);
					const headers = toStringRecord(rawConfig.headers);
					const cwd = typeof rawConfig.cwd === 'string' ? rawConfig.cwd.replace('${workspaceFolder}', workspaceFolder.fsPath) : undefined;

					if (!type || type === 'local' || type === 'stdio') {
						const command = typeof rawConfig.command === 'string' ? rawConfig.command : undefined;
						if (!command) {
							this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP local server "${serverName}" due to missing command.`);
							continue;
						}

						const localConfig: MCPLocalServerConfig = {
							type: type === 'stdio' ? 'stdio' : 'local',
							command,
							args,
							tools,
							env: env ?? {},
						};
						if (cwd) {
							localConfig.cwd = cwd;
						}
						processedConfig[serverName] = localConfig;
					} else if (type === 'http' || type === 'sse') {
						const url = typeof rawConfig.url === 'string' ? rawConfig.url : undefined;
						if (!url) {
							this.logService.warn(`[CopilotCLIMCPHandler] Skipping MCP remote server "${serverName}" due to missing url.`);
							continue;
						}
						processedConfig[serverName] = {
							type,
							url,
							headers: headers ?? {},
							tools,
						};
					} else {
						this.logService.warn(`[CopilotCLIMCPHandler] Unsupported MCP server type "${type}" for "${serverName}".`);
					}
				}
			}

			return processedConfig;
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to load MCP config: ${error}`);
			return undefined;
		}
	}
}