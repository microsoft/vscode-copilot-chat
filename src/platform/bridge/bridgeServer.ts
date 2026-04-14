/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { Emitter, Event } from '../../util/vs/base/common/event';
import { Disposable } from '../../util/vs/base/common/lifecycle';

export interface BridgeConversationSummary {
	readonly id: string;
	readonly title: string;
	readonly lastUpdated: number;
	readonly provider?: BridgeConversationProvider;
	readonly status?: BridgeConversationStatus;
}

export type BridgeConversationProvider = 'local' | 'claude' | 'copilot-cli' | 'cloud' | 'codex' | 'unknown';

export type BridgeConversationStatus = 'completed' | 'in-progress' | 'input-needed' | 'failed' | 'read' | 'archived' | 'unknown';

export interface BridgeConversationFilter {
	readonly providers?: readonly string[];
	readonly statuses?: readonly string[];
	readonly search?: string;
}

export type BridgeAssistantStatusKind = 'progress' | 'warning' | 'thinking';

export interface BridgeAssistantStatusItem {
	readonly kind: BridgeAssistantStatusKind;
	readonly content: string;
}

export interface BridgeAssistantToolInvocationItem {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly message: string | undefined;
	readonly isError: boolean;
	readonly isComplete: boolean;
}

export interface BridgeAssistantReferenceItem {
	readonly label: string;
	readonly uri: string | undefined;
}

export interface BridgeAssistantCodeCitationItem {
	readonly uri: string;
	readonly license: string;
	readonly snippet: string;
}

export interface BridgeAssistantConfirmationItem {
	readonly title: string;
	readonly message: string;
	readonly buttons: readonly string[] | undefined;
}

export type BridgeQuestionType = 'text' | 'singleSelect' | 'multiSelect' | 'unknown';

export interface BridgeQuestionItem {
	readonly id: string;
	readonly type: BridgeQuestionType;
	readonly title: string;
	readonly message: string | undefined;
	readonly options: readonly string[] | undefined;
	readonly allowFreeformInput: boolean;
}

export interface BridgeAssistantQuestionCarouselItem {
	readonly allowSkip: boolean;
	readonly questions: readonly BridgeQuestionItem[];
}

export interface BridgeAssistantCommandButtonItem {
	readonly commandId: string;
	readonly title: string;
	readonly args: readonly unknown[] | undefined;
}

export interface BridgeAssistantAnchorItem {
	readonly kind: 'anchor';
	readonly label: string;
	readonly uri: string | undefined;
}

export interface BridgeAssistantFileTreeItem {
	readonly kind: 'fileTree';
	readonly baseUri: string;
	readonly tree: string;
}

export interface BridgeAssistantCodeblockUriItem {
	readonly kind: 'codeblockUri';
	readonly uri: string;
	readonly isEdit: boolean;
	readonly undoStopId: string | undefined;
}

export interface BridgeAssistantTextEditItem {
	readonly kind: 'textEdit';
	readonly uri: string;
	readonly editCount: number;
	readonly isDone: boolean;
}

export interface BridgeAssistantNotebookEditItem {
	readonly kind: 'notebookEdit';
	readonly uri: string;
	readonly editCount: number;
	readonly isDone: boolean;
}

export interface BridgeAssistantWorkspaceEditOperationItem {
	readonly oldUri: string | undefined;
	readonly newUri: string | undefined;
}

export interface BridgeAssistantWorkspaceEditItem {
	readonly kind: 'workspaceEdit';
	readonly edits: readonly BridgeAssistantWorkspaceEditOperationItem[];
}

export interface BridgeAssistantMoveItem {
	readonly kind: 'move';
	readonly uri: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface BridgeAssistantExtensionsItem {
	readonly kind: 'extensions';
	readonly extensions: readonly string[];
}

export interface BridgeAssistantPullRequestItem {
	readonly kind: 'pullRequest';
	readonly title: string;
	readonly description: string;
	readonly author: string;
	readonly linkTag: string;
	readonly commandId: string | undefined;
	readonly commandArgs: readonly unknown[] | undefined;
}

export interface BridgeAssistantExternalEditItem {
	readonly kind: 'externalEdit';
	readonly uris: readonly string[];
}

export interface BridgeAssistantMultiDiffEntryItem {
	readonly originalUri: string | undefined;
	readonly modifiedUri: string | undefined;
	readonly goToFileUri: string | undefined;
	readonly added: number | undefined;
	readonly removed: number | undefined;
}

export interface BridgeAssistantMultiDiffItem {
	readonly kind: 'multiDiff';
	readonly title: string;
	readonly readOnly: boolean;
	readonly entries: readonly BridgeAssistantMultiDiffEntryItem[];
}

export type BridgeAssistantExtraItem =
	| BridgeAssistantAnchorItem
	| BridgeAssistantFileTreeItem
	| BridgeAssistantCodeblockUriItem
	| BridgeAssistantTextEditItem
	| BridgeAssistantNotebookEditItem
	| BridgeAssistantWorkspaceEditItem
	| BridgeAssistantMoveItem
	| BridgeAssistantExtensionsItem
	| BridgeAssistantPullRequestItem
	| BridgeAssistantExternalEditItem
	| BridgeAssistantMultiDiffItem;

export interface BridgeAssistantTurnArtifacts {
	readonly statuses?: readonly BridgeAssistantStatusItem[];
	readonly tools?: readonly BridgeAssistantToolInvocationItem[];
	readonly references?: readonly BridgeAssistantReferenceItem[];
	readonly codeCitations?: readonly BridgeAssistantCodeCitationItem[];
	readonly confirmations?: readonly BridgeAssistantConfirmationItem[];
	readonly questionCarousels?: readonly BridgeAssistantQuestionCarouselItem[];
	readonly commandButtons?: readonly BridgeAssistantCommandButtonItem[];
	readonly extras?: readonly BridgeAssistantExtraItem[];
}

export interface BridgeTurnHistoryItem {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly timestamp: number;
	readonly toolLines?: readonly string[];
	readonly artifacts?: BridgeAssistantTurnArtifacts;
}

export interface BridgeModeOption {
	readonly id: string;
	readonly label: string;
}

export interface BridgeModelOption {
	readonly id: string;
	readonly label: string;
	readonly vendor: string;
	readonly family: string | undefined;
}

export type BridgeUiCommandId = string;

export type BridgeMessage =
	| {
		type: 'conversation:list';
		conversations: readonly BridgeConversationSummary[];
	}
	| {
		type: 'ui:state';
		modes: readonly BridgeModeOption[];
		selectedModeId: string;
		models: readonly BridgeModelOption[];
		selectedModelId: string | undefined;
		workspaceLabel?: string;
	}
	| {
		type: 'conversation:history';
		conversationId: string;
		turns: readonly BridgeTurnHistoryItem[];
	}
	| {
		type: 'turn:start';
		conversationId: string;
		turnId: string;
		role: 'assistant';
	}
	| {
		type: 'turn:chunk';
		conversationId: string;
		turnId: string;
		content: string;
	}
	| {
		type: 'turn:reference';
		conversationId: string;
		turnId: string;
		label: string;
		uri?: string;
	}
	| {
		type: 'turn:codeCitation';
		conversationId: string;
		turnId: string;
		uri: string;
		license: string;
		snippet: string;
	}
	| {
		type: 'turn:status';
		conversationId: string;
		turnId: string;
		kind: BridgeAssistantStatusKind;
		content: string;
	}
	| {
		type: 'turn:tool';
		conversationId: string;
		turnId: string;
		toolName: string;
		toolCallId: string;
		message?: string;
		isError: boolean;
		isComplete: boolean;
	}
	| {
		type: 'turn:confirmation';
		conversationId: string;
		turnId: string;
		title: string;
		message: string;
		buttons?: readonly string[];
	}
	| {
		type: 'turn:questions';
		conversationId: string;
		turnId: string;
		allowSkip: boolean;
		questions: readonly BridgeQuestionItem[];
	}
	| {
		type: 'turn:button';
		conversationId: string;
		turnId: string;
		commandId: string;
		title: string;
		args?: readonly unknown[];
	}
	| {
		type: 'turn:extra';
		conversationId: string;
		turnId: string;
		extra: BridgeAssistantExtraItem;
	}
	| {
		type: 'turn:complete';
		conversationId: string;
		turnId: string;
	}
	| {
		type: 'turn:user';
		conversationId: string;
		turnId: string;
		content: string;
	};

type PromptSubmitMessage = {
	type: 'prompt:submit';
	content: string;
	conversationId?: string;
};

type ConversationSelectMessage = {
	type: 'conversation:select';
	conversationId: string;
};

type ConversationListRequestMessage = {
	type: 'conversation:list:request';
	filter?: BridgeConversationFilter;
};

type UiModelSetMessage = {
	type: 'ui:model:set';
	modelId: string;
};

type UiModeSetMessage = {
	type: 'ui:mode:set';
	modeId: string;
};

type UiCommandMessage = {
	type: 'ui:command';
	commandId: BridgeUiCommandId;
	args?: readonly unknown[];
};

type ClientMessage = PromptSubmitMessage | ConversationSelectMessage | ConversationListRequestMessage | UiModelSetMessage | UiModeSetMessage | UiCommandMessage;

const SESSION_TOKEN_BYTES = 16;

function createSessionToken(): string {
	return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isConversationFilter(value: unknown): value is BridgeConversationFilter {
	if (!isRecord(value)) {
		return false;
	}

	const providers = value.providers;
	const statuses = value.statuses;
	const search = value.search;

	if (providers !== undefined && !isStringArray(providers)) {
		return false;
	}

	if (statuses !== undefined && !isStringArray(statuses)) {
		return false;
	}

	if (search !== undefined && typeof search !== 'string') {
		return false;
	}

	return true;
}

function isClientMessage(value: unknown): value is ClientMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}

	switch (value.type) {
		case 'prompt:submit': {
			return typeof value.content === 'string' && (value.conversationId === undefined || typeof value.conversationId === 'string');
		}
		case 'conversation:select': {
			return typeof value.conversationId === 'string';
		}
		case 'conversation:list:request': {
			return value.filter === undefined || isConversationFilter(value.filter);
		}
		case 'ui:model:set': {
			return typeof value.modelId === 'string';
		}
		case 'ui:mode:set': {
			return typeof value.modeId === 'string';
		}
		case 'ui:command': {
			return typeof value.commandId === 'string'
				&& (value.args === undefined || Array.isArray(value.args));
		}
		default: {
			return false;
		}
	}
}

function toRawText(data: RawData): string {
	if (typeof data === 'string') {
		return data;
	}

	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}

	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}

	return data.toString();
}

export class BridgeServer extends Disposable {
	private server: HttpServer | undefined;
	private wss: WebSocketServer | undefined;
	private readonly clients = new Set<WebSocket>();
	private _sessionToken = createSessionToken();

	private readonly _onDidClientCountChange = this._register(new Emitter<number>());
	readonly onDidClientCountChange: Event<number> = this._onDidClientCountChange.event;

	onPromptReceived: ((prompt: string, conversationId?: string) => void) | undefined;
	onConversationSelected: ((conversationId: string, respond: (message: BridgeMessage) => void) => void) | undefined;
	onConversationListRequested: ((respond: (message: BridgeMessage) => void, filter?: BridgeConversationFilter) => void) | undefined;
	onUiModelSelected: ((modelId: string) => void) | undefined;
	onUiModeSelected: ((modeId: string) => void) | undefined;
	onUiCommandRequested: ((commandId: BridgeUiCommandId, args?: readonly unknown[]) => void) | undefined;

	get sessionToken(): string {
		return this._sessionToken;
	}

	get connectedClients(): number {
		return this.clients.size;
	}

	async start(port = 0): Promise<number> {
		if (this.server) {
			const currentAddress = this.server.address();
			if (currentAddress && typeof currentAddress !== 'string') {
				return currentAddress.port;
			}
		}

		this.server = createServer((req, res) => this.handleHttpRequest(req, res));
		this.wss = new WebSocketServer({ noServer: true });

		this.server.on('upgrade', (request, socket, head) => {
			if (!this.wss) {
				socket.destroy();
				return;
			}

			const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
			const token = requestUrl.searchParams.get('token');
			if (token !== this._sessionToken) {
				socket.write('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n');
				socket.destroy();
				return;
			}

			this.wss.handleUpgrade(request, socket, head, websocket => {
				this.wss?.emit('connection', websocket, request);
			});
		});

		this.wss.on('connection', websocket => {
			this.clients.add(websocket);
			this._onDidClientCountChange.fire(this.clients.size);

			const respond = (message: BridgeMessage) => {
				this.sendToClient(websocket, message);
			};

			this.onConversationListRequested?.(respond);

			websocket.on('message', data => {
				const text = toRawText(data);
				let parsedMessage: unknown;
				try {
					parsedMessage = JSON.parse(text);
				} catch {
					return;
				}

				if (!isClientMessage(parsedMessage)) {
					return;
				}

				switch (parsedMessage.type) {
					case 'prompt:submit': {
						const prompt = parsedMessage.content.trim();
						if (prompt.length > 0) {
							this.onPromptReceived?.(prompt, parsedMessage.conversationId);
						}
						break;
					}
					case 'conversation:select': {
						this.onConversationSelected?.(parsedMessage.conversationId, respond);
						break;
					}
					case 'conversation:list:request': {
						this.onConversationListRequested?.(respond, parsedMessage.filter);
						break;
					}
					case 'ui:model:set': {
						this.onUiModelSelected?.(parsedMessage.modelId);
						break;
					}
					case 'ui:mode:set': {
						this.onUiModeSelected?.(parsedMessage.modeId);
						break;
					}
					case 'ui:command': {
						this.onUiCommandRequested?.(parsedMessage.commandId, parsedMessage.args);
						break;
					}
				}
			});

			websocket.on('close', () => {
				this.clients.delete(websocket);
				this._onDidClientCountChange.fire(this.clients.size);
			});

			websocket.on('error', () => {
				this.clients.delete(websocket);
				this._onDidClientCountChange.fire(this.clients.size);
			});
		});

		await new Promise<void>((resolve, reject) => {
			if (!this.server) {
				reject(new Error('Bridge server failed to initialize.'));
				return;
			}

			const errorListener = (error: Error) => {
				this.server?.off('listening', listeningListener);
				reject(error);
			};
			const listeningListener = () => {
				this.server?.off('error', errorListener);
				resolve();
			};

			this.server.once('error', errorListener);
			this.server.once('listening', listeningListener);
			this.server.listen(port, '127.0.0.1');
		});

		const address = this.server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Bridge server failed to bind to a TCP port.');
		}

		return (address as AddressInfo).port;
	}

	async stop(): Promise<void> {
		for (const client of this.clients) {
			client.close();
		}
		this.clients.clear();
		this._onDidClientCountChange.fire(this.clients.size);

		await Promise.all([
			new Promise<void>(resolve => this.wss?.close(() => resolve()) ?? resolve()),
			new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve()),
		]);

		this.wss = undefined;
		this.server = undefined;
	}

	override dispose(): void {
		void this.stop();
		super.dispose();
	}

	regenerateToken(): void {
		this._sessionToken = createSessionToken();
		for (const client of this.clients) {
			client.close(4001, 'Token regenerated');
		}
		this.clients.clear();
		this._onDidClientCountChange.fire(this.clients.size);
	}

	broadcast(message: BridgeMessage): void {
		const payload = JSON.stringify(message);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(payload);
			}
		}
	}

	private sendToClient(client: WebSocket, message: BridgeMessage): void {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		client.send(JSON.stringify(message));
	}

	private handleHttpRequest(_request: IncomingMessage, response: ServerResponse): void {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(`<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Copilot Sidecar Bridge</title>
	<style>
		body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; background: #111827; color: #e5e7eb; }
		main { max-width: 640px; margin: 0 auto; }
		.card { background: #1f2937; border-radius: 12px; padding: 1rem 1.2rem; }
		.key { color: #93c5fd; }
		.value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
	</style>
</head>
<body>
	<main>
		<h1>Copilot Sidecar Bridge</h1>
		<div class="card">
			<p><span class="key">Connected clients:</span> <span class="value">${this.clients.size}</span></p>
			<p><span class="key">Session token:</span> <span class="value">${this._sessionToken}</span></p>
		</div>
	</main>
</body>
</html>`);
	}
}
