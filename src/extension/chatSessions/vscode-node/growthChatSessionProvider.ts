/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

// TODO: Just for demonstration
const tips: string[] = [
	'**Inline suggestions** — As you type, Copilot suggests code completions in gray text. Press `Tab` to accept, or `Esc` to dismiss. You can also press `Alt+]` / `Option+]` to cycle through alternatives.',
	'**Ask mode vs Agent mode** — Use *Ask* mode when you want explanations or answers without changing files. Switch to *Agent* mode when you want Copilot to plan and make edits across your project autonomously.',
	'**Attach context** — Use `#file`, `#selection`, or `#codebase` in your message to give Copilot targeted context. The more relevant context you provide, the better the response.',
	'**Inline Chat** — Press `Ctrl+I` (`Cmd+I` on Mac) to open Inline Chat directly in the editor. It\'s great for quick edits, refactors, or generating code right where your cursor is.',
	'**Fix with Copilot** — When you see a diagnostic squiggle, hover over it and click the lightbulb to see *Fix with Copilot*. It can analyze the error and suggest a targeted fix.',
	'**Generate tests** — Ask Copilot to write unit tests for a function by selecting the code and typing "write tests for this" in chat. It understands your testing framework and project conventions.',
	'**Explain code** — Select a block of code you don\'t understand and ask "explain this" in chat. Copilot will break it down step by step.',
	'**Terminal commands** — Not sure about a shell command? Ask Copilot in chat — for example, "how do I find all files modified in the last 24 hours?" and it will give you the right command.',
	'**Custom instructions** — Create a `.github/copilot-instructions.md` file in your project to teach Copilot about your coding conventions, preferred libraries, and project-specific patterns.',
	'**Multi-file edits** — In Agent mode, Copilot can create, edit, and delete multiple files in a single task. Describe what you want at a high level and let it work out the details.',
];

/**
 * Combined item provider, content provider, and chat participant for product
 * growth and user education.
 *
 * Provides a single session that shows a {@link vscode.ChatSessionStatus.NeedsInput}
 * attention badge until the user opens it, at which point it transitions to
 * {@link vscode.ChatSessionStatus.Completed}. Subsequent messages return random
 * Copilot tips.
 */
export class GrowthChatSessionProvider extends Disposable implements vscode.ChatSessionItemProvider, vscode.ChatSessionContentProvider {

	public static readonly sessionType = 'copilot-growth';
	public static readonly sessionId = 'growth-tip';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	private readonly _created = Date.now();
	private _seen = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	// #region ChatSessionItemProvider

	/**
	 * Mark the session as seen (interacted with by the user). Clears the
	 * NeedsInput attention badge. Called both when the user opens the
	 * session (via {@link provideChatSessionContent}) and when the user
	 * sends a message (via the request handler).
	 */
	private _markSeen(): void {
		if (!this._seen) {
			this._logService.trace(`[GrowthProvider] _markSeen() — clearing attention, hasListeners=${this._onDidChangeChatSessionItems.hasListeners()}`);
			this._seen = true;
			this._onDidChangeChatSessionItems.fire();
			this._logService.trace('[GrowthProvider] _markSeen() — fire() completed');
		}
	}

	public async provideChatSessionItems(_token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const status = this._seen ? vscode.ChatSessionStatus.Completed : vscode.ChatSessionStatus.NeedsInput;
		this._logService.trace(`[GrowthProvider] provideChatSessionItems called, _seen=${this._seen}, status=${status}`);
		return [{
			resource: GrowthSessionUri.forSessionId(GrowthChatSessionProvider.sessionId),
			label: 'Try Copilot',
			description: 'GitHub Copilot is now enabled. Try for free?',
			status,
			timing: {
				created: this._created,
				lastRequestStarted: this._created,
			},
			iconPath: new vscode.ThemeIcon('lightbulb'),
		}];
	}

	// #endregion

	// #region ChatSessionContentProvider

	public async provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this._logService.trace(`[GrowthProvider] provideChatSessionContent called, resource=${resource.toString()}`);

		// Only serve growth content for the known growth-tip session.
		// Untitled sessions (created when the user presses "new chat" or
		// navigates away) should get empty history so they don't re-show
		// the growth content and trap the user in a loop.
		const sessionId = resource.path.slice(1); // strip leading '/'
		if (sessionId !== GrowthChatSessionProvider.sessionId) {
			return { history: [], requestHandler: undefined };
		}

		// Opening the session content clears the NeedsInput attention badge.
		this._markSeen();

		const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [
			new vscode.ChatRequestTurn2(
				'Tell me about GitHub Copilot!',
				undefined,            // command
				[],                   // references
				GrowthChatSessionProvider.sessionType, // participant
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
				GrowthChatSessionProvider.sessionType, // participant
			),
		];

		return { history, requestHandler: undefined };
	}

	// #endregion

	// #region Chat participant handler

	public createHandler(): ChatExtendedRequestHandler {
		return this._handleRequest.bind(this);
	}

	private async _handleRequest(
		_request: vscode.ChatRequest,
		_context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		this._markSeen();
		const tip = tips[Math.floor(Math.random() * tips.length)];
		stream.markdown(tip + '\n\n*Send a message to get another GitHub Copilot tip.*');
		return {};
	}

	// #endregion
}

export namespace GrowthSessionUri {
	export function forSessionId(sessionId: string): vscode.Uri {
		return vscode.Uri.from({ scheme: GrowthChatSessionProvider.sessionType, path: '/' + sessionId });
	}
}
