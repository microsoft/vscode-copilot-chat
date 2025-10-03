/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatRequest, ChatRequestTurn2, ChatResponseStream, ChatSession, ChatSessionContentProvider, ChatSessionItem, ChatSessionItemProvider, ChatToolInvocationPart, Event, EventEmitter, ProviderResult } from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatStep } from '../common/chatReplayResponses';
import { ReplaySessionManager } from '../common/replaySessionManager';
import { EditHelper } from './editHelper';

export class ChatReplaySessionProvider extends Disposable implements ChatSessionContentProvider, ChatSessionItemProvider {
	private _onDidChangeChatSessionItems = this._register(new EventEmitter<void>());
	readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly editHelper: EditHelper;
	private readonly _sessionManager: ReplaySessionManager;

	constructor(IWorkspaceService: IWorkspaceService, sessionManager?: ReplaySessionManager) {
		super();
		this.editHelper = new EditHelper(IWorkspaceService);
		this._sessionManager = sessionManager ?? this._register(new ReplaySessionManager());
	}

	onDidCommitChatSessionItem: Event<{ original: ChatSessionItem; modified: ChatSessionItem }> = this._register(new EventEmitter<{ original: ChatSessionItem; modified: ChatSessionItem }>()).event;

	provideNewChatSessionItem?(options: { readonly request: ChatRequest; metadata?: unknown }, token: CancellationToken): ProviderResult<ChatSessionItem> {
		throw new Error('Method not implemented.');
	}

	provideChatSessionItems(token: CancellationToken): ProviderResult<ChatSessionItem[]> {
		return [];
	}

	// ChatSessionContentProvider implementation
	provideChatSessionContent(sessionId: string, token: CancellationToken): ChatSession {
		return this.startReplayDebugging(sessionId, token);
	}

	initializeReplaySession(sessionId: string) {
		const session = this._sessionManager.CreateNewSession(sessionId);
		return session.allSteps;
	}

	currentStep(sessionId: string): ChatStep | undefined {
		const session = this._sessionManager.getSession(sessionId);
		return session?.currentStep;
	}

	getSession(sessionId: string) {
		return this._sessionManager.getSession(sessionId);
	}

	// private convertStepsToHistory(chatSteps: ChatStep[], debugMode: boolean = false): ReadonlyArray<ChatRequestTurn | ChatResponseTurn2> {
	// 	const history: (ChatRequestTurn | ChatResponseTurn2)[] = [];
	// 	let currentResponseSteps: ChatStep[] = [];

	// 	for (const step of chatSteps) {
	// 		if (step.kind === 'userQuery') {
	// 			// In debug mode, only include completed response turns
	// 			if (!debugMode && currentResponseSteps.length > 0) {
	// 				history.push(this.createResponseTurn(currentResponseSteps));
	// 				currentResponseSteps = [];
	// 			}

	// 			// Always create request turn for user query
	// 			history.push(this.createRequestTurn(step));
	// 		} else if (step.kind === 'request' || step.kind === 'toolCall') {
	// 			// In debug mode, don't add response steps to history - they'll be streamed
	// 			if (!debugMode) {
	// 				currentResponseSteps.push(step);
	// 			}
	// 		}
	// 	}

	// 	// Complete any remaining response turn (only in non-debug mode)
	// 	if (!debugMode && currentResponseSteps.length > 0) {
	// 		history.push(this.createResponseTurn(currentResponseSteps));
	// 	}

	// 	return history;
	// }

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
			history,
			activeResponseCallback: (stream, token) => this.handleActiveResponse(sessionId, stream, token),
			requestHandler: undefined // This will be read-only for replay
		};
	}

	private async handleActiveResponse(sessionId: string, stream: ChatResponseStream, token: CancellationToken): Promise<void> {
		const replaySession = this._sessionManager.getSession(sessionId);
		if (!replaySession) {
			return;
		}

		for await (const step of replaySession.iterateSteps()) {
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
		}
	}

	fireSessionsChanged(): void {
		this._onDidChangeChatSessionItems.fire();
	}
}