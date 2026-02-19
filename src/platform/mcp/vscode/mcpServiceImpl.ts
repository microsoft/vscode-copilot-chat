/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type McpGateway, lm } from 'vscode';
import { AbstractMcpService } from '../common/mcpService';

export class McpService extends AbstractMcpService {
	declare readonly _serviceBrand: undefined;

	private cachedGateway: Promise<McpGateway | undefined> | undefined;

	get mcpServerDefinitions() {
		return lm.mcpServerDefinitions;
	}

	get onDidChangeMcpServerDefinitions() {
		return lm.onDidChangeMcpServerDefinitions;
	}

	getMcpGateway(): Promise<McpGateway | undefined> {
		this.cachedGateway ??= Promise.resolve(lm.startMcpGateway());
		return this.cachedGateway;
	}
}
