/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
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
		readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
		readonly logFilePath?: string;
	};
	readonly session: {
		readonly autoSave: boolean;
		readonly maxHistory: number;
		readonly enableRealTimeSync: boolean;
	};
	readonly tools: {
		readonly enablePermissions: boolean;
		readonly autoApproveReadOnly: boolean;
		readonly dangerousToolsConfirm: boolean;
	};
	readonly defaultModel?: string;
	readonly defaultAgent?: string;
	readonly workspace: {
		readonly enableProjectAnalysis: boolean;
		readonly watchFiles: boolean;
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
				logLevel: config?.server?.logLevel ?? 'info',
				logFilePath: config?.server?.logFilePath || undefined,
			},
			session: {
				autoSave: config?.session?.autoSave ?? true,
				maxHistory: config?.session?.maxHistory ?? 100,
				enableRealTimeSync: config?.session?.enableRealTimeSync ?? true,
			},
			tools: {
				enablePermissions: config?.tools?.enablePermissions ?? true,
				autoApproveReadOnly: config?.tools?.autoApproveReadOnly ?? true,
				dangerousToolsConfirm: config?.tools?.dangerousToolsConfirm ?? true,
			},
			defaultModel: config?.defaultModel || undefined,
			defaultAgent: config?.defaultAgent || undefined,
			workspace: {
				enableProjectAnalysis: config?.workspace?.enableProjectAnalysis ?? true,
				watchFiles: config?.workspace?.watchFiles ?? true,
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
	private _process: cp.ChildProcess | undefined;
	private _config: IOpenCodeServerConfig | undefined;

	constructor(
		private readonly hostname: string,
		private readonly port: number,
		private readonly timeout: number,
		private readonly logService: ILogService
	) { }

	async start(token?: CancellationToken): Promise<IOpenCodeServerConfig> {
		if (this._process) {
			throw new Error('OpenCode server is already running');
		}

		return new Promise((resolve, reject) => {
			// Build the command arguments for opencode serve
			const args = ['serve'];

			// Add hostname and port if specified
			if (this.hostname !== '127.0.0.1') {
				args.push('--hostname', this.hostname);
			}

			if (this.port !== 0) {
				args.push('--port', this.port.toString());
			}

			this.logService.trace(`[OpenCodeServer] Spawning: opencode ${args.join(' ')}`);

			// Spawn the opencode serve process
			this._process = cp.spawn('opencode', args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...process.env,
					// Set OPENCODE_CONFIG_CONTENT if needed for authentication
					// This will be implemented in later phases when we understand the config structure
				}
			});

			// Handle process errors
			this._process.on('error', (error) => {
				this.logService.error(`[OpenCodeServer] Process error: ${error instanceof Error ? error.message : String(error)}`);
				this._process = undefined;
				reject(new Error(`Failed to start opencode server: ${error.message}`));
			});

			// Handle process exit
			this._process.on('exit', (code, signal) => {
				this.logService.info(`[OpenCodeServer] Process exited with code ${code}, signal ${signal}`);
				this._process = undefined;
				this._config = undefined;
			});

			// Handle cancellation
			if (token) {
				token.onCancellationRequested(() => {
					if (this._process) {
						this.logService.info('[OpenCodeServer] Cancellation requested, stopping server');
						this._process.kill('SIGTERM');
					}
				});
			}

			// Capture stdout to detect when server is ready and extract port
			let stdoutBuffer = '';
			this._process.stdout?.on('data', (data) => {
				const chunk = data.toString();
				stdoutBuffer += chunk;
				this.logService.trace(`[OpenCodeServer] stdout: ${chunk}`);

				// Look for server ready indication
				// This pattern may need to be adjusted based on actual opencode serve output
				const serverReadyMatch = stdoutBuffer.match(/Server listening on.*:(\d+)|Server started.*port (\d+)|listening.*:(\d+)/i);
				if (serverReadyMatch && !this._config) {
					const detectedPort = parseInt(serverReadyMatch[1] || serverReadyMatch[2] || serverReadyMatch[3], 10);
					const actualPort = this.port === 0 ? detectedPort : this.port;

					this._config = {
						hostname: this.hostname,
						port: actualPort,
						url: `http://${this.hostname}:${actualPort}`
					};

					this.logService.info(`[OpenCodeServer] Server ready at ${this._config.url}`);
					resolve(this._config);
				}
			});

			// Capture stderr for logging
			this._process.stderr?.on('data', (data) => {
				const chunk = data.toString();
				this.logService.warn(`[OpenCodeServer] stderr: ${chunk}`);
			});

			// Set a timeout in case we don't detect the server starting
			const startupTimeout = setTimeout(() => {
				if (!this._config) {
					this.logService.error('[OpenCodeServer] Startup timeout - server did not become ready');
					if (this._process) {
						this._process.kill('SIGTERM');
					}
					reject(new Error('OpenCode server startup timeout'));
				}
			}, this.timeout);

			// Clear timeout when we resolve
			const originalResolve = resolve;
			resolve = (config) => {
				clearTimeout(startupTimeout);
				originalResolve(config);
			};

			const originalReject = reject;
			reject = (error) => {
				clearTimeout(startupTimeout);
				originalReject(error);
			};
		});
	}

	async stop(): Promise<void> {
		if (!this._process) {
			return;
		}

		return new Promise((resolve) => {
			const process = this._process!;

			// Set up exit handler
			const onExit = () => {
				this._process = undefined;
				this._config = undefined;
				resolve();
			};

			process.on('exit', onExit);

			// Try graceful shutdown first
			process.kill('SIGTERM');

			// Force kill after timeout
			setTimeout(() => {
				if (this._process === process) {
					this.logService.warn('[OpenCodeServer] Force killing process after timeout');
					process.kill('SIGKILL');
				}
			}, 5000);
		});
	}

	isRunning(): boolean {
		return this._process !== undefined && !this._process.killed;
	}

	getUrl(): string {
		return this._config?.url ?? '';
	}
}