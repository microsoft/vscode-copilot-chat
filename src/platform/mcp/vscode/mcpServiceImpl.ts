/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpGateway, Uri, lm } from 'vscode';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { AbstractMcpService } from '../common/mcpService';
import { ILogService } from '../../log/common/logService';

class TrackedMcpGateway implements McpGateway {
	constructor(
		private readonly _gateway: McpGateway,
		private readonly _onDispose: () => void
	) { }

	get address(): Uri {
		return this._gateway.address;
	}

	dispose(): void {
		this._onDispose();
		this._gateway.dispose();
	}
}

export class McpService extends AbstractMcpService implements IDisposable {
	declare readonly _serviceBrand: undefined;

	private readonly _gateways = new Map<string, TrackedMcpGateway>();

	constructor(@ILogService private readonly _logService: ILogService) {
		super();
	}

	get mcpServerDefinitions() {
		return lm.mcpServerDefinitions;
	}

	get onDidChangeMcpServerDefinitions() {
		return lm.onDidChangeMcpServerDefinitions;
	}

	async startMcpGateway(sessionId: string): Promise<McpGateway | undefined> {
		const existing = this._gateways.get(sessionId);
		if (existing) {
			return existing;
		}

		// TODO: When the API supports passing sessionId, we should pass it here to ensure the gateway is correctly associated with the session.
		try {
			const gateway = await lm.startMcpGateway();
			if (gateway) {
				const tracked = new TrackedMcpGateway(gateway, () => this._gateways.delete(sessionId));
				this._gateways.set(sessionId, tracked);
				return tracked;
			}
		} catch (error) {
			this._logService.warn(`Failed to start MCP Gateway: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}

	dispose(): void {
		for (const gateway of this._gateways.values()) {
			gateway.dispose();
		}
		this._gateways.clear();
	}
}
