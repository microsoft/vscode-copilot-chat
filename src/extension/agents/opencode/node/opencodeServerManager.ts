/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createOpencodeServer } from '@opencode-ai/sdk';
import type { CancellationToken } from 'vscode';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';

export interface IOpenCodeServerConfig {
	readonly url: string;
	readonly port: number;
	readonly hostname: string;
}

export interface OpenCodeConfiguration {
	readonly server: {
		readonly hostname: string;
		readonly port: number;
		readonly timeout: number;
		readonly autoStart: boolean;
	};
}

export const IOpenCodeServerManager = createServiceIdentifier<IOpenCodeServerManager>('IOpenCodeServerManager');

export interface IOpenCodeServerManager {
	readonly _serviceBrand: undefined;
	start(token?: CancellationToken): Promise<IOpenCodeServerConfig>;
	stop(): Promise<void>;
	getConfig(): IOpenCodeServerConfig | undefined;
	isRunning(): boolean;
}

export class OpenCodeServerManager extends Disposable implements IOpenCodeServerManager {
	declare _serviceBrand: undefined;

	private _server: OpenCodeServer | undefined;
	private _config: IOpenCodeServerConfig | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
	}

	private getConfiguration(): OpenCodeConfiguration {
		const config = this.configurationService.getNonExtensionConfig<any>('opencode');
		return {
			server: {
				hostname: config?.server?.hostname ?? '127.0.0.1',
				port: config?.server?.port ?? 0,
				timeout: config?.server?.timeout ?? 5000,
				autoStart: config?.server?.autoStart ?? true,
			},
		};
	}

	async start(token?: CancellationToken): Promise<IOpenCodeServerConfig> {
		const userConfig = this.getConfiguration();

		if (!userConfig.server.autoStart) {
			throw new Error('OpenCode server auto-start is disabled');
		}

		if (this._server && this._server.isRunning()) {
			return this.getConfig()!;
		}

		this.logService.info('[OpenCodeServerManager] Starting OpenCode server...');

		const hostname = userConfig.server.hostname;
		const port = userConfig.server.port;

		this._server = new OpenCodeServer(hostname, port, userConfig.server.timeout, this.logService);

		try {
			this._config = await this._server.start(token);
			this.logService.info(`[OpenCodeServerManager] OpenCode server started at ${this._config.url}`);
			return this._config;
		} catch (error) {
			this.logService.error('[OpenCodeServerManager] Failed to start OpenCode server', error);
			this._server = undefined;
			this._config = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this._server) {
			this.logService.info('[OpenCodeServerManager] Stopping OpenCode server...');
			try {
				await this._server.stop();
				this.logService.info('[OpenCodeServerManager] OpenCode server stopped');
			} catch (error) {
				this.logService.error('[OpenCodeServerManager] Error stopping OpenCode server', error);
			} finally {
				this._server = undefined;
				this._config = undefined;
			}
		}
	}

	getConfig(): IOpenCodeServerConfig | undefined {
		return this._config ? { ...this._config } : undefined;
	}

	isRunning(): boolean {
		return this._server?.isRunning() ?? false;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}

class OpenCodeServer {
	private _config: IOpenCodeServerConfig | undefined;
	private _sdkServer: any | undefined;

	constructor(
		private readonly hostname: string,
		private readonly port: number,
		private readonly timeout: number,
		private readonly logService: ILogService
	) { }

	async start(token?: CancellationToken): Promise<IOpenCodeServerConfig> {
		if (this._sdkServer) {
			throw new Error('OpenCode server is already running');
		}
		const ac = new AbortController();
		if (token) {
			token.onCancellationRequested(() => ac.abort());
		}
		this._sdkServer = await createOpencodeServer({ hostname: this.hostname, port: this.port, timeout: this.timeout, signal: ac.signal });
		const url: string = String(this._sdkServer.url || `http://${this.hostname}:${this.port || 4096}`);
		const parsed = new URL(url);
		const actualPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
		this._config = { hostname: parsed.hostname || this.hostname, port: actualPort, url };
		this.logService.info(`[OpenCodeServer] (SDK) Server ready at ${this._config.url}`);
		return this._config;
	}

	// CLI fallback removed; SDK server is always used

	async stop(): Promise<void> {
		if (this._sdkServer) {
			try {
				await this._sdkServer.close();
				this.logService.info('[OpenCodeServer] (SDK) Server closed');
			} catch (e) {
				this.logService.error('[OpenCodeServer] (SDK) Error during close', e);
			} finally {
				this._sdkServer = undefined;
				this._config = undefined;
			}
		}
	}

	isRunning(): boolean {
		return (this._sdkServer !== undefined);
	}

	getUrl(): string {
		return this._config?.url ?? '';
	}
}
