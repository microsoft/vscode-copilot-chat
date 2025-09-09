/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import type { CancellationToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IOpenCodeServerConfig } from './opencodeServerManager';

export interface OpenCodeMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system';
	readonly content: string;
	readonly timestamp: Date;
	readonly sessionId?: string;
}

export interface OpenCodeSessionData {
	readonly id: string;
	readonly label: string;
	readonly messages: readonly OpenCodeMessage[];
	readonly timestamp: Date;
	readonly status: 'active' | 'idle' | 'completed' | 'error';
}

export interface CreateSessionOptions {
	readonly label?: string;
	readonly initialMessage?: string;
}

export interface SendMessageOptions {
	readonly content: string;
	readonly sessionId: string;
}

export interface ApiResponse<T> {
	readonly success: boolean;
	readonly data?: T;
	readonly error?: string;
}

export const IOpenCodeClient = createServiceIdentifier<IOpenCodeClient>('IOpenCodeClient');

export interface IOpenCodeClient {
	readonly _serviceBrand: undefined;
	setConfig(config: IOpenCodeServerConfig): void;
	getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]>;
	getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined>;
	createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData>;
	sendMessage(options: SendMessageOptions, token?: CancellationToken): Promise<OpenCodeMessage>;
	deleteSession(sessionId: string, token?: CancellationToken): Promise<void>;
}

export class OpenCodeClient extends Disposable implements IOpenCodeClient {
	declare _serviceBrand: undefined;

	private _config: IOpenCodeServerConfig | undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	setConfig(config: IOpenCodeServerConfig): void {
		this._config = config;
		this.logService.trace(`[OpenCodeClient] Config set: ${config.url}`);
	}

	private ensureConfig(): IOpenCodeServerConfig {
		if (!this._config) {
			throw new Error('OpenCodeClient not configured. Call setConfig() first.');
		}
		return this._config;
	}

	async getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]> {
		const config = this.ensureConfig();
		
		try {
			const response = await this.makeRequest<OpenCodeSessionData[]>({
				method: 'GET',
				path: '/api/sessions',
				config,
				token
			});

			return response.data ?? [];
		} catch (error) {
			this.logService.error('[OpenCodeClient] Failed to get all sessions', error);
			throw error;
		}
	}

	async getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined> {
		const config = this.ensureConfig();
		
		try {
			const response = await this.makeRequest<OpenCodeSessionData>({
				method: 'GET',
				path: `/api/sessions/${encodeURIComponent(sessionId)}`,
				config,
				token
			});

			return response.data;
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to get session ${sessionId}`, error);
			// Return undefined for 404 errors (session not found)
			if (error instanceof Error && error.message.includes('404')) {
				return undefined;
			}
			throw error;
		}
	}

	async createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData> {
		const config = this.ensureConfig();
		
		try {
			const body = JSON.stringify({
				label: options?.label,
				initialMessage: options?.initialMessage
			});

			const response = await this.makeRequest<OpenCodeSessionData>({
				method: 'POST',
				path: '/api/sessions',
				body,
				config,
				token,
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.data) {
				throw new Error('Failed to create session: no data returned');
			}

			this.logService.info(`[OpenCodeClient] Created session: ${response.data.id}`);
			return response.data;
		} catch (error) {
			this.logService.error('[OpenCodeClient] Failed to create session', error);
			throw error;
		}
	}

	async sendMessage(options: SendMessageOptions, token?: CancellationToken): Promise<OpenCodeMessage> {
		const config = this.ensureConfig();
		
		try {
			const body = JSON.stringify({
				content: options.content
			});

			const response = await this.makeRequest<OpenCodeMessage>({
				method: 'POST',
				path: `/api/sessions/${encodeURIComponent(options.sessionId)}/messages`,
				body,
				config,
				token,
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.data) {
				throw new Error('Failed to send message: no data returned');
			}

			return response.data;
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to send message to session ${options.sessionId}`, error);
			throw error;
		}
	}

	async deleteSession(sessionId: string, token?: CancellationToken): Promise<void> {
		const config = this.ensureConfig();
		
		try {
			await this.makeRequest<void>({
				method: 'DELETE',
				path: `/api/sessions/${encodeURIComponent(sessionId)}`,
				config,
				token
			});

			this.logService.info(`[OpenCodeClient] Deleted session: ${sessionId}`);
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to delete session ${sessionId}`, error);
			throw error;
		}
	}

	private async makeRequest<T>(options: {
		method: string;
		path: string;
		config: IOpenCodeServerConfig;
		body?: string;
		headers?: Record<string, string>;
		token?: CancellationToken;
	}): Promise<ApiResponse<T>> {
		const { method, path, config, body, headers = {}, token } = options;
		
		if (token?.isCancellationRequested) {
			throw new CancellationError();
		}

		const url = new URL(path, config.url);
		const isHttps = url.protocol === 'https:';
		const httpModule = isHttps ? https : http;

		this.logService.trace(`[OpenCodeClient] ${method} ${url.href}`);

		return new Promise((resolve, reject) => {
			const requestOptions: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method,
				headers: {
					'User-Agent': 'VSCode-OpenCode-Client',
					...headers
				}
			};

			if (body) {
				const headers = requestOptions.headers as Record<string, string>;
				headers['Content-Length'] = Buffer.byteLength(body).toString();
			}

			const req = httpModule.request(requestOptions, (res) => {
				let responseBody = '';

				res.on('data', (chunk) => {
					responseBody += chunk.toString();
				});

				res.on('end', () => {
					try {
						this.logService.trace(`[OpenCodeClient] Response ${res.statusCode}: ${responseBody}`);

						if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
							// Success response
							let data: T | undefined;
							if (responseBody.trim()) {
								try {
									data = JSON.parse(responseBody);
								} catch (parseError) {
									this.logService.warn(`[OpenCodeClient] Failed to parse response JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
								}
							}
							resolve({ success: true, data });
						} else {
							// Error response
							let errorMessage = `HTTP ${res.statusCode}`;
							try {
								const errorData = JSON.parse(responseBody);
								errorMessage = errorData.error || errorData.message || errorMessage;
							} catch {
								errorMessage = responseBody || errorMessage;
							}
							reject(new Error(`${errorMessage} (${res.statusCode})`));
						}
					} catch (error) {
						reject(error);
					}
				});
			});

			req.on('error', (error) => {
				this.logService.error(`[OpenCodeClient] Request error: ${error instanceof Error ? error.message : String(error)}`);
				reject(error);
			});

			// Handle cancellation
			if (token) {
				token.onCancellationRequested(() => {
					req.destroy();
					reject(new CancellationError());
				});
			}

			// Send request body if present
			if (body) {
				req.write(body);
			}

			req.end();
		});
	}
}