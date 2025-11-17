/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpHttpServerDefinition2, McpServerDefinitionProvider } from 'vscode';
import { GITHUB_SCOPE_ALIGNED } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';

export class GitHubMcpDefinitionProvider extends Disposable implements McpServerDefinitionProvider<McpHttpServerDefinition2> {

	readonly onDidChangeMcpServerDefinitions: Event<void>;

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this.onDidChangeMcpServerDefinitions = Event.chain(configurationService.onDidChangeConfiguration, $ => $
			.filter(e => e.affectsConfiguration(ConfigKey.GitHubMcpToolsets.fullyQualifiedId))
			.map(() => { })
		);
	}

	private get toolsets(): string[] {
		return this.configurationService.getConfig<string[]>(ConfigKey.GitHubMcpToolsets);
	}

	provideMcpServerDefinitions(): McpHttpServerDefinition2[] {
		return [
			{
				label: 'GitHub',
				uri: URI.parse('https://api.githubcopilot.com/mcp/'),
				headers: {
					'X-MCP-Toolsets': this.toolsets.join(',')
				},
				version: '1.0',
				authentication: {
					providerId: 'github',
					scopes: GITHUB_SCOPE_ALIGNED
				}
			}
		];
	}
}
