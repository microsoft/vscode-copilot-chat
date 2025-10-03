/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, chat, ChatRequestTurn2, ChatResponseStream, ChatSession, ChatSessionContentProvider, ChatToolInvocationPart, Event, EventEmitter } from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatStep } from '../common/chatReplayResponses';
import { ReplaySessionManager } from '../common/replaySessionManager';
import { EditHelper } from './editHelper';

export class ChatReplaySessionProvider extends Disposable implements ChatSessionContentProvider {
	private _onDidChangeChatSessionItems = this._register(new EventEmitter<void>());
	readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly editHelper: EditHelper;
	private readonly _sessionManager: ReplaySessionManager;
	private debuggingSessionId: string | undefined;

	constructor(IWorkspaceService: IWorkspaceService, sessionManager?: ReplaySessionManager) {
		super();
		this.editHelper = new EditHelper(IWorkspaceService);
		this._sessionManager = sessionManager ?? this._register(new ReplaySessionManager());
	}

	createParticipant() {
		return chat.createChatParticipant('chat-replay', async (request, context, responseStream, token) => {
			if (this.debuggingSessionId) {
				await this.handleActiveResponse(this.debuggingSessionId, responseStream, token);
				return;
			}
			responseStream.markdown('No replay is active');
		});
	}

	// ChatSessionContentProvider implementation
	provideChatSessionContent(sessionId: string, token: CancellationToken): ChatSession {
		return this.startReplayDebugging(sessionId, token);
	}

	initializeReplaySession(sessionId: string) {
		this.debuggingSessionId = sessionId;
		const session = this._sessionManager.CreateNewSession(sessionId);
		const query = session.stepNext();
		return query && query.kind === 'userQuery' ? this.createRequestTurn(query) : undefined;
	}

	currentStep(sessionId: string): ChatStep | undefined {
		const session = this._sessionManager.getSession(sessionId);
		return session?.currentStep;
	}

	getSession(sessionId: string) {
		return this._sessionManager.getSession(sessionId);
	}

	private createRequestTurn(step: ChatStep & { kind: 'userQuery' }): ChatRequestTurn2 {
		return new ChatRequestTurn2(step.query, undefined, [], 'copilot', [], undefined);
	}

	// Method to start debugging/stepping through a replay session
	public startReplayDebugging(sessionId: string, token: CancellationToken): ChatSession {
		// Handle debug session ID prefix
		const actualSessionId = sessionId.startsWith('debug:') ? sessionId.substring(6) : sessionId;

		// Ensure session is loaded
		const session = this._sessionManager.getSession(actualSessionId);
		const query = session?.stepNext();
		const history = query && query.kind === 'userQuery' ? [this.createRequestTurn(query)] : [];

		return {
			history: history,
			requestHandler: undefined // handled by chat participant
		};
	}

	private async handleActiveResponse(sessionId: string, stream: ChatResponseStream, token: CancellationToken): Promise<void> {
		const replaySession = this._sessionManager.getSession(sessionId);
		if (!replaySession) {
			return;
		}

		let step = await replaySession.waitForNextStep();
		while (step) {
			if (token.isCancellationRequested) {
				break;
			}

			if (step.kind === 'request') {
				const result = Array.isArray(step.result) ? step.result.join('') : (step.result || '');
				stream.markdown(result);
			} else if (step.kind === 'toolCall') {
				const toolPart = new ChatToolInvocationPart(step.toolName, step.id);
				toolPart.isComplete = true;
				toolPart.isError = false;
				toolPart.isConfirmed = true;

				for (const edit of step.edits) {
					await this.editHelper.makeEdit(edit, stream);
				}

				stream.push(toolPart);
			}

			step = await replaySession.waitForNextStep();
		}
	}

	fireSessionsChanged(): void {
		this._onDidChangeChatSessionItems.fire();
	}
}