/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CancellationError, LanguageModelTextPart, LanguageModelToolInformation, LanguageModelToolResult } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../common/toolNames';
import { ICopilotTool } from '../common/toolsRegistry';
import { BaseToolsService } from '../common/toolsService';

type McpServers = {
	servers: {
		[key: string]: {
			type: string;
			command: string;
			args: string[];
			env?: Record<string, string>;
			cwd?: string;
		};
	};
}

export class McpToolsService extends BaseToolsService {
	declare _serviceBrand: undefined;

	private readonly _copilotTools: Lazy<Map<ToolName, ICopilotTool<any>>>;
	private mcpTools: vscode.LanguageModelToolInformation[] = [];
	private readonly mcpClients: Map<string, Client> = new Map();
	private readonly toolToServerMap: Map<string, string> = new Map();
	private initializationPromise: Promise<void> | undefined;

	/**
	 * Check if all MCP servers have been initialized
	 * @returns true if all MCP servers have completed initialization, false otherwise
	 */
	static isMcpServersInitialized(): boolean {
		return process.env.MCP_SERVERS_INITIALIZED === 'true';
	}

	get tools(): ReadonlyArray<vscode.LanguageModelToolInformation> {
		// Trigger initialization if not already done
		this.ensureInitialized();

		return this.mcpTools.map(tool => {
			return {
				...tool,
				name: getToolName(tool.name),
				description: mapContributedToolNamesInString(tool.description),
				inputSchema: tool.inputSchema && mapContributedToolNamesInSchema(tool.inputSchema),
			};
		});
	}

	public get copilotTools() {
		return this._copilotTools.value;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService
	) {
		super(logService);
		this._copilotTools = new Lazy(() => new Map());

		// Initialize the environment variable as false at startup
		process.env.MCP_SERVERS_INITIALIZED = 'false';
	}

	/**
	 * Ensures the MCP tools are initialized. This method is called lazily when tools are accessed.
	 */
	private ensureInitialized(): void {
		if (this.initializationPromise) {
			return; // Already initializing or initialized
		}

		this.initializationPromise = this.initializeAsync();
	}

	/**
	 * Ensures the MCP tools are initialized and waits for completion. Used in async contexts.
	 */
	private async ensureInitializedAsync(): Promise<void> {
		if (!this.initializationPromise) {
			this.initializationPromise = this.initializeAsync();
		}
		await this.initializationPromise;
	}

	/**
	 * Asynchronously initialize MCP clients and tools
	 */
	private async initializeAsync(): Promise<void> {
		if (process.env.MCP_CONFIG_FILE === undefined) {
			return;
		}

		try {
			const config = fs.readFileSync(process.env.MCP_CONFIG_FILE, 'utf8');
			const mcpServers: McpServers = JSON.parse(config);

			const initPromises: Promise<void>[] = [];

			for (const [name, server] of Object.entries(mcpServers.servers)) {
				initPromises.push(this.initializeServer(name, server));
			}

			await Promise.allSettled(initPromises);

			// Set environment variable to indicate all MCP servers have completed initialization
			process.env.MCP_SERVERS_INITIALIZED = 'true';
		} catch (error) {
		}
	}

	/**
	 * Initialize a single MCP server
	 */
	private async initializeServer(name: string, server: {
		type: string;
		command: string;
		args: string[];
		env?: Record<string, string>;
		cwd?: string;
	}): Promise<void> {
		let transport;
		const configuredEnv = server.env ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, replaceEnvVariables(value)])) : undefined;
		// combine env with process.env, ensuring all values are strings (no undefined)
		const rawEnv = configuredEnv ? { ...process.env, ...configuredEnv } : process.env;
		const combinedEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(rawEnv)) {
			if (typeof value === 'string') {
				combinedEnv[key] = value;
			}
		}

		if (server.type === 'stdio') {
			transport = new StdioClientTransport({
				command: replaceEnvVariables(server.command),
				args: server.args.map((arg: string) => replaceEnvVariables(arg)),
				env: combinedEnv,
				stderr: 'inherit', // Default behavior, can be customized if needed
				cwd: server.cwd ? replaceEnvVariables(server.cwd) : undefined,
			});
		} else {
			return; // Unsupported transport type
		}

		const maxRetries = 5;
		const retryDelay = 2000; // 2 seconds

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// Create a separate client for each server
				const mcpClient = new Client({ name: `mcp-client-${name}`, version: '1.0.0' });
				this.mcpClients.set(name, mcpClient);

				await mcpClient.connect(transport);
				const mcpTools = (await mcpClient.listTools()).tools;
				for (const tool of mcpTools) {
					const info: LanguageModelToolInformation = {
						name: tool.name,
						description: tool.description as string,
						inputSchema: tool.inputSchema,
						tags: ['vscode_editing'],
						source: { name: 'mcp', label: `MCP Server: ${name}` },
					};
					this.mcpTools.push(info);
					// Map tool name to server name for later lookup
					this.toolToServerMap.set(tool.name, name);
				}
				return; // Success, exit retry loop
			} catch (error) {
				// Clean up failed client
				this.mcpClients.delete(name);

				if (attempt === maxRetries) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, retryDelay));
			}
		}
	}

	async invokeTool(name: string | ToolName, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Promise<LanguageModelToolResult | vscode.LanguageModelToolResult2> {
		this._onWillInvokeTool.fire({ toolName: name });

		// Ensure initialization is complete before invoking tools
		await this.ensureInitializedAsync();

		// Find which server provides this tool
		const serverName = this.toolToServerMap.get(name as string);
		if (!serverName) {
			throw new Error(`Tool ${name} not found in any MCP server`);
		}

		const mcpClient = this.mcpClients.get(serverName);
		if (!mcpClient) {
			throw new Error(`MCP client for server ${serverName} not found`);
		}


		const invokeToolTimeout = process.env.SIMULATION_INVOKE_TOOL_TIMEOUT ? parseInt(process.env.SIMULATION_INVOKE_TOOL_TIMEOUT, 10) : 60_000;
		const result = await mcpClient.callTool({
			name: name,
			arguments: options.input as Record<string, unknown>,
		}, undefined, { timeout: invokeToolTimeout, maxTotalTimeout: invokeToolTimeout });
		if (!result) {
			throw new CancellationError();
		}
		const parts = [];
		if (result.structuredContent) {
			parts.push(new LanguageModelTextPart(JSON.stringify(result.structuredContent)));
		}
		for (const part of result.content as { text: string }[]) {
			parts.push(new LanguageModelTextPart(part.text as string));
		}
		return new LanguageModelToolResult(parts);
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		const tool = this._copilotTools.value.get(name as ToolName);
		return tool;
	}

	getTool(name: string | ToolName): vscode.LanguageModelToolInformation | undefined {
		// Trigger initialization if not already done
		this.ensureInitialized();
		return this.tools.find(tool => tool.name === name);
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		// Can't actually implement this in prod, name is not exposed
		throw new Error('This method for tests only');
	}

	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] {
		this.ensureInitialized();

		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		return this.tools.filter(tool => {
			// 0. Check if the tool was disabled via the tool picker. If so, it must be disabled here
			const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
			if (toolPickerSelection === false) {
				return false;
			}

			// 1. Check for what the consumer wants explicitly
			const explicit = filter?.(tool);
			if (explicit !== undefined) {
				return explicit;
			}

			// 2. Check if the request's tools explicitly asked for this tool to be enabled
			for (const ref of request.toolReferences) {
				const usedTool = toolMap.get(ref.name);
				if (usedTool?.tags.includes(`enable_other_tool_${tool.name}`)) {
					return true;
				}
			}

			// 3. If this tool is neither enabled nor disabled, then consumer didn't have opportunity to enable/disable it.
			// This can happen when a tool is added during another tool call (e.g. installExt tool installs an extension that contributes tools).
			if (toolPickerSelection === undefined && tool.tags.includes('extension_installed_by_tool')) {
				return true;
			}

			// Tool was enabled via tool picker
			if (toolPickerSelection === true) {
				return true;
			}

			return false;
		});
	}

	/**
	 * Dispose of all MCP client connections
	 */
	override dispose(): void {
		super.dispose();

		for (const [, client] of this.mcpClients) {
			try {
				client.close();
			} catch (error) {
			}
		}
		this.mcpClients.clear();
		this.toolToServerMap.clear();

		// Reset environment variable when disposing
		process.env.MCP_SERVERS_INITIALIZED = 'false';
	}
}

function replaceEnvVariables(str: string): string {
	return str.replace(/\$\{([^}]+)\}/g, (match: string, varName: string) => {
		return process.env[varName] || '';
	});
}