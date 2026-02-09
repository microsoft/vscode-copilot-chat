/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { GrowthChatSessionItemProvider } from './growthChatSessionItemProvider';

/**
 * Content provider for growth/educational chat sessions.
 *
 * When the user opens the growth session, the provider clears the
 * NeedsInput attention badge via {@link GrowthChatSessionItemProvider.markSeen}
 * and returns a session with a single request turn describing Copilot Chat.
 */
export class GrowthChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly _itemProvider: GrowthChatSessionItemProvider,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	public async provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this._logService.info(`[GrowthContentProvider] provideChatSessionContent called, resource=${resource.toString()}`);

		// Only serve growth content for the known growth-tip session.
		// Untitled sessions (created when the user presses "new chat" or
		// navigates away) should get empty history so they don't re-show
		// the growth content and trap the user in a loop.
		const sessionId = resource.path.slice(1); // strip leading '/'
		if (sessionId !== GrowthChatSessionItemProvider.sessionId) {
			return { history: [], requestHandler: undefined };
		}

		// Opening the session clears the NeedsInput attention badge.
		this._itemProvider.markSeen();

		const sessionType = GrowthChatSessionItemProvider.sessionType;

		const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [
			new vscode.ChatRequestTurn2(
				'Tell me about GitHub Copilot!',
				undefined,            // command
				[],                   // references
				sessionType,          // participant
				[],                   // toolReferences
				undefined,            // editedFileEvents
				undefined,            // id
			),
			new vscode.ChatResponseTurn2(
				[
					new vscode.ChatResponseMarkdownPart(
						'GitHub Copilot is your AI coding assistant, built right into VS Code. ' +
						'It helps you write code faster by suggesting completions as you type, ' +
						'answering questions about your codebase, and even generating entire ' +
						'functions or files from natural language descriptions. Whether you\'re ' +
						'exploring a new framework or working on a familiar project, Copilot ' +
						'adapts to your context and coding style.\n\n' +
						'You can chat with Copilot here to ask questions, get explanations, ' +
						'debug issues, or brainstorm ideas. Try asking it to explain a piece of ' +
						'code, write a unit test, or help you refactor. Copilot can also work ' +
						'autonomously in Agent Mode — give it a task and it will plan, make edits ' +
						'across files, and run terminal commands to get the job done.\n\n' +
						'*Send a message to get another GitHub Copilot tip.*'
					),
				],
				{},                   // result
				sessionType,          // participant
			),
		];

		return { history, requestHandler: undefined };
	}
}
