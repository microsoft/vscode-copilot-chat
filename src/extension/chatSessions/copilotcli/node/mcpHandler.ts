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
import { Disposable, DisposableStore, IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { GitHubMcpDefinitionProvider } from '../../../githubMcp/common/githubMcpDefinitionProvider';

const toolInvalidCharRe = /[^a-z0-9_-]/gi;

export type MCPServerConfig = NonNullable<Session['mcpServers']>[string];

export interface ICopilotCLIMCPHandler {
	readonly _serviceBrand: undefined;
	loadMcpConfig(): Promise<{ config: Record<string, MCPServerConfig>; disposable: IDisposable } | undefined>;
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

	public async loadMcpConfig(): Promise<{ config: Record<string, MCPServerConfig>; disposable: IDisposable } | undefined> {

		// TODO: Sessions window settings override is not honored with extension
		//       configuration API, so this needs to be a core setting
		const isSessionsWindow = this.configurationService.getNonExtensionConfig<boolean>('chat.experimentalSessionsWindowOverride') ?? false;

		// Sessions window: use the gateway approach which proxies all MCP servers from core
		if (isSessionsWindow) {
			return this.loadMcpConfigWithGateway();
		}

		// Standard path: use the CLIMCPServerEnabled setting
		const enabled = this.configurationService.getConfig(ConfigKey.Advanced.CLIMCPServerEnabled);
		this.logService.info(`[CopilotCLIMCPHandler] loadMcpConfig called. CLIMCPServerEnabled=${enabled}`);

		if (!enabled) {
			this.logService.info('[CopilotCLIMCPHandler] MCP server forwarding is disabled, returning undefined');
			return undefined;
		}

		const result = await this.loadMcpConfigWithGateway();
		if (result?.config) {
			await this.addBuiltInGitHubServer(result.config);
			return result;
		} else {
			const config: Record<string, MCPServerConfig> = {};
			await this.addBuiltInGitHubServer(config);
			if (Object.keys(config).length === 0) {
				return undefined;
			}
			return { config, disposable: Disposable.None };
		}
	}

	/**
	 * Use the Gateway to handle all connections
	 */
	private async loadMcpConfigWithGateway(): Promise<{ config: Record<string, MCPServerConfig>; disposable: IDisposable } | undefined> {
		const processedConfig: Record<string, MCPServerConfig> = {};
		const disposableStore = new DisposableStore();
		try {
			const gateway = await this.mcpService.startMcpGateway(URI.from({ scheme: 'copilot-cli-mcp-server', path: generateUuid() })) ?? undefined;
			if (gateway) {
				disposableStore.add(gateway);
				processedConfig['vscode-mcp-gateway'] = {
					type: 'http',
					url: gateway.address.toString(),
					isDefaultServer: true,
					tools: ['*'],
					displayName: 'VS Code MCP Gateway',
				};
				this.logService.info(`[CopilotCLIMCPHandler]   gateway: ${gateway.address.toString()}`);
			} else {
				this.logService.warn('[CopilotCLIMCPHandler]   gateway failed to start');
			}
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler]   gateway error: ${error}`);
		}

		const serverIds = Object.keys(processedConfig);
		this.logService.info(`[CopilotCLIMCPHandler] Final config: ${serverIds.length} server(s): [${serverIds.join(', ')}]`);
		if (serverIds.length) {
			return { config: processedConfig, disposable: disposableStore };
		}
		disposableStore.dispose();
		return undefined;
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

	private async addBuiltInGitHubServer(config: Record<string, MCPServerConfig>): Promise<void> {
		try {
			const githubId = this.normalizeServerName('gitHub');
			if (!githubId) {
				return;
			}

			// Override only if no GitHub MCP server is already configured
			if (config[githubId] && config[githubId].type === 'http') {
				// We have headers, do not override
				if (Object.keys(config[githubId].headers || {}).length > 0) {
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

			config[githubId] = {
				type: 'http',
				url: resolvedDefinition.uri.toString(),
				isDefaultServer: true,
				headers: resolvedDefinition.headers,
				tools: ['*'],
				displayName: 'GitHub',
			};
			this.logService.trace('[CopilotCLIMCPHandler] Added built-in GitHub MCP server.');
		} catch (error) {
			this.logService.warn(`[CopilotCLIMCPHandler] Failed to add built-in GitHub MCP server: ${error}`);
		}
	}
}
