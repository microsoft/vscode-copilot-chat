/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpencodeClient } from '@opencode-ai/sdk/client';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface OpenCodeSession {
	id: string;
	title: string;
	directory: string;
	projectID: string;
	slug?: string;
	version?: string;
	summary?: {
		additions: number;
		deletions: number;
		files: number;
	};
	time?: {
		created: number;
		updated: number;
	};
}

export interface OpenCodeMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: OpenCodeMessagePart[];
	time?: {
		created: number;
		updated: number;
	};
}

export interface OpenCodeMessagePart {
	type: 'text' | 'tool-invocation' | 'tool-result';
	text?: string;
	toolInvocation?: {
		id: string;
		name: string;
		state?: {
			input?: Record<string, unknown>;
			title?: string;
		};
	};
	toolResult?: {
		id: string;
		result?: unknown;
		is_error?: boolean;
	};
}

export interface IOpenCodeSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Connects to an existing OpenCode server or starts a new one
	 * @returns The server URL
	 */
	ensureServer(): Promise<string>;

	/**
	 * Lists all OpenCode sessions
	 * @returns Array of session info objects
	 */
	listSessions(): Promise<OpenCodeSession[]>;

	/**
	 * Gets detailed information for a specific session
	 * @param sessionId Session ID
	 * @returns Session info object, or undefined if not found
	 */
	getSession(sessionId: string): Promise<OpenCodeSession | undefined>;

	/**
	 * Creates a new session
	 * @param title Optional title for the session
	 * @returns The created session
	 */
	createSession(title?: string): Promise<OpenCodeSession>;

	/**
	 * Gets all messages for a specific session
	 * @param sessionId Session ID
	 * @returns Array of session messages
	 */
	getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]>;

	/**
	 * Sends a message to a session
	 * @param sessionId Session ID
	 * @param text Message text
	 * @returns Response status
	 */
	sendMessage(sessionId: string, text: string): Promise<{ status: number }>;

	/**
	 * Deletes a session
	 * @param sessionId Session ID
	 */
	deleteSession(sessionId: string): Promise<void>;

	/**
	 * Subscribes to server-sent events
	 * @param callback Callback for each event
	 * @returns Cleanup function
	 */
	subscribeToEvents(callback: (event: unknown) => void): Promise<() => void>;

	/**
	 * Stops the server if we started it
	 */
	stopServer(): Promise<void>;
}

export const IOpenCodeSdkService = createServiceIdentifier<IOpenCodeSdkService>('IOpenCodeSdkService');

/**
 * Service that wraps the OpenCode SDK for DI in tests and lazy loading
 */
export class OpenCodeSdkService implements IOpenCodeSdkService {
	readonly _serviceBrand: undefined;

	private _sdk: Promise<typeof import('@opencode-ai/sdk')> | undefined;
	private _client: OpencodeClient | undefined;
	private _serverUrl: string | undefined;
	private _server: { url: string; close: () => void } | undefined;
	private _isExternalServer: boolean = false;

	dispose(): void {
		if (!this._isExternalServer && this._server) {
			this._server.close();
			this._server = undefined;
		}
		this._client = undefined;
		this._serverUrl = undefined;
	}

	private async _loadSdk() {
		this._sdk ??= import('@opencode-ai/sdk');
		return this._sdk;
	}

	private async _tryConnectExisting(url: string): Promise<boolean> {
		try {
			const { createOpencodeClient } = await this._loadSdk();
			const client = createOpencodeClient({ baseUrl: url });
			await client.session.list();
			return true;
		} catch {
			return false;
		}
	}

	public async ensureServer(): Promise<string> {
		if (this._serverUrl && this._client) {
			return this._serverUrl;
		}

		const { createOpencodeClient, createOpencodeServer } = await this._loadSdk();

		// Optionally connect to an existing server on the default port.
		// This is opt-in via environment variable to avoid silently trusting
		// any process that happens to be listening on the well-known port.
		if (process.env['OPENCODE_USE_EXISTING_SERVER'] === '1') {
			const defaultUrl = 'http://127.0.0.1:4096';
			if (await this._tryConnectExisting(defaultUrl)) {
				this._serverUrl = defaultUrl;
				this._client = createOpencodeClient({ baseUrl: defaultUrl });
				this._isExternalServer = true;
				return this._serverUrl;
			}
		}

		// No existing server (or opt-in not set), start a new embedded one
		const randomPort = Math.floor(Math.random() * (65535 - 49152) + 49152);
		this._server = await createOpencodeServer({
			hostname: '127.0.0.1',
			port: randomPort,
			timeout: 10000
		});
		this._serverUrl = this._server.url;
		this._client = createOpencodeClient({ baseUrl: this._serverUrl });
		this._isExternalServer = false;

		return this._serverUrl;
	}

	private async _getClient() {
		if (!this._client) {
			await this.ensureServer();
		}
		return this._client!;
	}

	public async listSessions(): Promise<OpenCodeSession[]> {
		const client = await this._getClient();
		const response = await client.session.list();
		return (response.data ?? []) as OpenCodeSession[];
	}

	public async getSession(sessionId: string): Promise<OpenCodeSession | undefined> {
		const client = await this._getClient();
		try {
			const response = await client.session.get({ path: { id: sessionId } });
			return response.data as OpenCodeSession | undefined;
		} catch {
			return undefined;
		}
	}

	public async createSession(title?: string): Promise<OpenCodeSession> {
		const client = await this._getClient();
		const response = await client.session.create({
			body: { title: title ?? `VS Code Session - ${new Date().toISOString()}` }
		});
		return response.data as OpenCodeSession;
	}

	public async getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]> {
		const client = await this._getClient();
		const response = await client.session.messages({ path: { id: sessionId } });
		return (response.data ?? []) as OpenCodeMessage[];
	}

	public async sendMessage(sessionId: string, text: string): Promise<{ status: number }> {
		const client = await this._getClient();
		const response = await client.session.prompt({
			path: { id: sessionId },
			body: { parts: [{ type: 'text', text }] }
		});
		return { status: response.response?.status ?? 200 };
	}

	public async deleteSession(sessionId: string): Promise<void> {
		const client = await this._getClient();
		await client.session.delete({ path: { id: sessionId } });
	}

	public async subscribeToEvents(callback: (event: unknown) => void): Promise<() => void> {
		const client = await this._getClient();
		const subscription = await client.event.subscribe({
			onMessage: callback
		});
		return () => {
			if (subscription?.abort) {
				subscription.abort();
			}
		};
	}

	public async stopServer(): Promise<void> {
		if (this._isExternalServer) {
			// Don't stop external servers
			this._client = undefined;
			this._serverUrl = undefined;
			return;
		}
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
		this._client = undefined;
		this._serverUrl = undefined;
	}
}
