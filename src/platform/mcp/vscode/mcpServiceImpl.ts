/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type McpGateway, lm } from 'vscode';
import { AbstractMcpService } from '../common/mcpService';
import type { IDisposable } from '../../../util/vs/base/common/lifecycle';

export class McpService extends AbstractMcpService implements IDisposable {
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

	dispose(): void {
		if (this.cachedGateway !== undefined) {
			const gatewayPromise = this.cachedGateway;
			this.cachedGateway = undefined;
			void gatewayPromise.then(gateway => {
				gateway?.dispose();
			});
		}
	}
}
