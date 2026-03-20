/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { OpenCodeSessionUri } from '../common/opencodeSessionUri';
import { OpenCodeAgentManager } from '../node/opencodeAgentManager';
import { IOpenCodeSdkService } from '../node/opencodeSdkService';
import { IOpenCodeSessionService, OpenCodeMessage } from '../node/opencodeSessionService';

export class OpenCodeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	private readonly _controller: OpenCodeChatSessionItemController;

	constructor(
		private readonly agentManager: OpenCodeAgentManager,
		@IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService,
		@IOpenCodeSdkService private readonly sdkService: IOpenCodeSdkService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._controller = this._register(new OpenCodeChatSessionItemController(sessionService, sdkService, logService));
	}

	public createHandler(): ChatExtendedRequestHandler {
		return async (
			request: vscode.ChatRequest,
			context: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken
		): Promise<vscode.ChatResult | void> => {
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				stream.markdown(vscode.l10n.t("Start a new OpenCode session"));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${OpenCodeSessionUri.scheme}`, title: vscode.l10n.t("Start Session") });
				return {};
			}

			const sessionId = OpenCodeSessionUri.getSessionId(chatSessionContext.chatSessionItem.resource);
			this.logService.trace(`[OpenCodeChatSessionContentProvider] Handling request for session: ${sessionId}`);

			try {
				await this.agentManager.handleRequest({
					sessionId,
					prompt: request.prompt,
					token,
					responseStream: stream,
				});

				return {};
			} catch (error) {
				this.logService.error(`[OpenCodeChatSessionContentProvider] Error handling request`, error);
				return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
			}
		};
	}

	async provideChatSessionContent(
		sessionResource: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<vscode.ChatSession> {
		const sessionId = OpenCodeSessionUri.getSessionId(sessionResource);
		this.logService.trace(`[OpenCodeChatSessionContentProvider] Providing content for session: ${sessionId}`);

		try {
			const messages = await this.sessionService.getSessionMessages(sessionId);
			if (token.isCancellationRequested) {
				return { history: [], requestHandler: undefined };
			}

			const history = this._buildChatHistory(messages);
			return {
				history,
				activeResponseCallback: undefined,
				requestHandler: undefined,
			};
		} catch (error) {
			this.logService.error(`[OpenCodeChatSessionContentProvider] Error providing content`, error);
			return { history: [], requestHandler: undefined };
		}
	}

	private _buildChatHistory(messages: OpenCodeMessage[]): (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] {
		const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];

		for (const message of messages) {
			if (message.role === 'user') {
				const prompt = message.parts
					.filter(p => p.type === 'text' && p.text)
					.map(p => p.text!)
					.join('');
				if (prompt) {
					history.push({
						prompt,
						participant: OpenCodeSessionUri.scheme,
						references: [],
						toolReferences: [],
					} as vscode.ChatRequestTurn);
				}
			} else if (message.role === 'assistant') {
				const responseParts: vscode.ChatResponseMarkdownPart[] = [];
				for (const part of message.parts) {
					if (part.type === 'text' && part.text) {
						responseParts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(part.text)));
					}
				}
				if (responseParts.length > 0) {
					history.push({
						response: responseParts,
						result: {},
						participant: OpenCodeSessionUri.scheme,
					} as vscode.ChatResponseTurn);
				}
			}
		}

		return history;
	}
}

export class OpenCodeChatSessionItemController extends Disposable {
	readonly controller: vscode.ChatSessionItemController;

	constructor(
		private readonly sessionService: IOpenCodeSessionService,
		private readonly sdkService: IOpenCodeSdkService,
		private readonly logService: ILogService,
	) {
		super();
		this.controller = this._register(vscode.chat.createChatSessionItemController(
			OpenCodeSessionUri.scheme,
			() => this._refreshItems(CancellationToken.None)
		));

		this.controller.newChatSessionItemHandler = async (context, _token) => {
			// Ensure server is running
			await this.sdkService.ensureServer();

			// Create a new session in OpenCode
			const session = await this.sessionService.createSession(context.request.prompt);

			const item = this.controller.createChatSessionItem(
				OpenCodeSessionUri.forSessionId(session.id),
				session.title || context.request.prompt,
			);
			item.iconPath = new vscode.ThemeIcon('rocket');
			item.timing = { created: Date.now() };
			return item;
		};
	}

	private async _refreshItems(token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		try {
			await this.sdkService.ensureServer();
			const sessions = await this.sessionService.listSessions();

			const items = sessions.map(session => {
				const item = this.controller.createChatSessionItem(
					OpenCodeSessionUri.forSessionId(session.id),
					session.title || session.slug || 'OpenCode Session',
				);
				item.iconPath = new vscode.ThemeIcon('rocket');
				if (session.time?.created !== undefined) {
					item.timing = {
						created: session.time.created,
					};
				}
				return item;
			});

			this.controller.items.replace(items);
		} catch (error) {
			this.logService.error('[OpenCodeChatSessionItemController] Error refreshing items', error);
		}
	}
}
