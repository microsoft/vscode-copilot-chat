/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, McpHttpServerDefinition, McpServerDefinitionProvider } from 'vscode';
import { authProviderId, IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { AuthProviderId, ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { Event } from '../../../util/vs/base/common/event';
import { URI } from '../../../util/vs/base/common/uri';
import * as l10n from '@vscode/l10n';

const EnterpriseURLConfig = 'github-enterprise.uri';

export class GitHubMcpDefinitionProvider implements McpServerDefinitionProvider<McpHttpServerDefinition> {

	readonly onDidChangeMcpServerDefinitions: Event<void>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService
	) {
		const configurationEvent = Event.chain(configurationService.onDidChangeConfiguration, $ => $
			.filter(e => {
				// If they change the toolsets
				if (e.affectsConfiguration(ConfigKey.GitHubMcpToolsets.fullyQualifiedId)) {
					logService.debug('GitHubMcpDefinitionProvider: Configuration change affects GitHub MCP toolsets.');
					return true;
				}
				// If they change to GHE or GitHub.com
				if (e.affectsConfiguration(ConfigKey.Shared.AuthProvider.fullyQualifiedId)) {
					logService.debug('GitHubMcpDefinitionProvider: Configuration change affects GitHub auth provider.');
					return true;
				}
				// If they change the GHE URL
				if (e.affectsConfiguration(EnterpriseURLConfig)) {
					logService.debug('GitHubMcpDefinitionProvider: Configuration change affects GitHub Enterprise URL.');
					return true;
				}
				return false;
			})
			// void event
			.map(() => { })
		);
		let havePermissiveToken = !!this.authenticationService.permissiveGitHubSession;
		const authEvent = Event.chain(this.authenticationService.onDidAuthenticationChange, $ => $
			.filter(() => {
				const hadToken = havePermissiveToken;
				havePermissiveToken = !!this.authenticationService.permissiveGitHubSession;
				return hadToken !== havePermissiveToken;
			})
			.map(() =>
				this.logService.debug(`GitHubMcpDefinitionProvider: Permissive GitHub session availability changed: ${havePermissiveToken}`))
		);
		this.onDidChangeMcpServerDefinitions = Event.any(configurationEvent, authEvent);
	}

	private get toolsets(): string[] {
		return this.configurationService.getConfig<string[]>(ConfigKey.GitHubMcpToolsets);
	}

	private get gheConfig(): string | undefined {
		return this.configurationService.getNonExtensionConfig<string>(EnterpriseURLConfig);
	}

	private getGheUri(): URI {
		const uri = this.gheConfig;
		if (!uri) {
			throw new Error('GitHub Enterprise URI is not configured.');
		}
		// Prefix with 'copilot-api.'
		const url = URI.parse(uri).with({ path: '/mcp/' });
		return url.with({ authority: `copilot-api.${url.authority}` });
	}

	provideMcpServerDefinitions(): McpHttpServerDefinition[] {
		const providerId = authProviderId(this.configurationService);
		const toolsets = this.toolsets.sort().join(',');
		const basics = providerId === AuthProviderId.GitHubEnterprise
			? { label: 'GitHub Enterprise', uri: this.getGheUri() }
			: { label: 'GitHub', uri: URI.parse('https://api.githubcopilot.com/mcp/') };
		return [
			{
				...basics,
				headers: {
					'X-MCP-Toolsets': toolsets
				},
				version: toolsets
			}
		];
	}

	async resolveMcpServerDefinition(server: McpHttpServerDefinition, token: CancellationToken): Promise<McpHttpServerDefinition | undefined> {
		const session = await this.authenticationService.getPermissiveGitHubSession({
			createIfNone: {
				detail: l10n.t('Additional permissions are required to use GitHub MCP Server'),
			},
		});
		server.headers['Authorization'] = `Bearer ${session!.accessToken}`;
		return server;
	}
}
