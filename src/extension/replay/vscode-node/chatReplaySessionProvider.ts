/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import { CancellationToken, ChatRequestTurn, ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseTurn2, ChatSession, ChatSessionContentProvider, ChatSessionItem, ChatSessionItemProvider, Event, EventEmitter, ProviderResult, Uri } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatStep, ModelRequest, ToolStep } from '../common/chatReplayResponses';
import { parseReplay } from '../node/replayParser';

export class ChatReplaySessionProvider extends Disposable implements ChatSessionContentProvider, ChatSessionItemProvider {
	private _onDidChangeChatSessionItems = this._register(new EventEmitter<void>());
	readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	constructor() {
		super();
	}

	onDidCommitChatSessionItem: Event<{ original: ChatSessionItem; modified: ChatSessionItem }> = this._register(new EventEmitter<{ original: ChatSessionItem; modified: ChatSessionItem }>()).event;

	provideChatSessionItems(token: CancellationToken): ProviderResult<ChatSessionItem[]> {
		return [];
	}

	provideChatSessionContent(resource: Uri, token: CancellationToken): ChatSession {
		const logFile = resource.with({ scheme: 'file' });

		const content = fs.readFileSync(logFile.fsPath, 'utf8');
		const chatSteps = parseReplay(content);

		return {
			history: this.convertStepsToHistory(chatSteps),
			requestHandler: undefined
		};
	}

	private convertStepsToHistory(chatSteps: ChatStep[]): ReadonlyArray<ChatRequestTurn | ChatResponseTurn2> {
		const history: (ChatRequestTurn | ChatResponseTurn2)[] = [];
		let currentResponseSteps: (ModelRequest | ToolStep)[] = [];

		for (const step of chatSteps) {
			if (step.kind === 'userQuery') {
				if (currentResponseSteps.length > 0) {
					history.push(this.createResponseTurn(currentResponseSteps));
					currentResponseSteps = [];
				}

				history.push(this.createRequestTurn(step));
			} else if (step.kind === 'request' || step.kind === 'toolCall') {
				currentResponseSteps.push(step);
			}
		}

		// Complete any remaining response turn (only in non-debug mode)
		if (currentResponseSteps.length > 0) {
			history.push(this.createResponseTurn(currentResponseSteps));
		}

		return history;
	}

	private createRequestTurn(step: ChatStep & { kind: 'userQuery' }): ChatRequestTurn2 {
		return new ChatRequestTurn2(step.query, undefined, [], 'copilot', [], undefined);
	}

	private createResponseTurn(steps: (ModelRequest | ToolStep)[]) {
		const responseParts: ChatResponseMarkdownPart[] = [];
		for (const step of steps) {
			if (step.kind === 'request' && step.result) {
				responseParts.push(new ChatResponseMarkdownPart(step.result));
			} else if (step.kind === 'toolCall') {
				responseParts.push(new ChatResponseMarkdownPart(`called ${step.toolName}`));
			}
		}
		return new ChatResponseTurn2(responseParts, {}, 'copilot');
	}

	fireSessionsChanged(): void {
		this._onDidChangeChatSessionItems.fire();
	}
}