/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpHttpServerDefinition2, McpServerDefinitionProvider } from 'vscode';
import { GITHUB_SCOPE_ALIGNED } from '../../../platform/authentication/common/authentication';
import { authProviderId } from '../../../platform/authentication/vscode-node/session';
import { AuthProviderId, ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';

const EnterpriseURLConfig = 'github-enterprise.uri';

export class GitHubMcpDefinitionProvider extends Disposable implements McpServerDefinitionProvider<McpHttpServerDefinition2> {

	readonly onDidChangeMcpServerDefinitions: Event<void>;
	private _version = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		this.onDidChangeMcpServerDefinitions = Event.chain(configurationService.onDidChangeConfiguration, $ => $
			.filter(e =>
				// If they change the toolsets
				e.affectsConfiguration(ConfigKey.GitHubMcpToolsets.fullyQualifiedId) ||
				// If they change to GHE or GitHub.com
				e.affectsConfiguration(ConfigKey.Shared.AuthProvider.fullyQualifiedId) ||
				// If they change the GHE URL
				e.affectsConfiguration(EnterpriseURLConfig)
			)
			// void event
			.map(() => { })
		);
	}

	private get toolsets(): string[] {
		return this.configurationService.getConfig<string[]>(ConfigKey.GitHubMcpToolsets);
	}

	private getGheUri(): URI {
		const uri = this.configurationService.getNonExtensionConfig<string>(EnterpriseURLConfig);
		if (!uri) {
			throw new Error('GitHub Enterprise URI is not configured.');
		}
		return URI.parse(uri);
	}

	provideMcpServerDefinitions(): McpHttpServerDefinition2[] {
		const providerId = authProviderId(this.configurationService);
		const basics = providerId === AuthProviderId.GitHubEnterprise
			? { label: 'GitHub Enterprise', uri: this.getGheUri() }
			: { label: 'GitHub', uri: URI.parse('https://api.githubcopilot.com/mcp/') };
		return [
			{
				...basics,
				headers: {
					'X-MCP-Toolsets': this.toolsets.join(',')
				},
				version: `1.${this._version++}`,
				authentication: {
					providerId,
					scopes: GITHUB_SCOPE_ALIGNED
				}
			}
		];
	}
}
