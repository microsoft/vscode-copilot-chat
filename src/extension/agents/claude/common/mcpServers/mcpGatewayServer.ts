/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { IMcpService } from '../../../../../platform/mcp/common/mcpService';
import { IClaudeMcpServerContributor, registerClaudeMcpServerContributor } from '../../common/claudeMcpServerRegistry';

class McpGatewayServerContributor implements IClaudeMcpServerContributor {

	constructor(
		@IMcpService private readonly mcpService: IMcpService,
	) { }

	async getMcpServers(): Promise<Record<string, McpServerConfig>> {
		const gateway = await this.mcpService.getMcpGateway();
		if (!gateway) {
			return {};
		}

		return {
			'vscode-mcp-gateway': {
				type: 'http',
				url: gateway.address.toString(),
			},
		};
	}
}

registerClaudeMcpServerContributor(McpGatewayServerContributor);
