/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

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
 * Chat participant for product growth and user education.
 * Responds with a random Copilot tip on each message.
 */
export class GrowthChatSessionParticipant extends Disposable {

	createHandler(): ChatExtendedRequestHandler {
		return this._handleRequest.bind(this);
	}

	private async _handleRequest(
		_request: vscode.ChatRequest,
		_context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		const tip = tips[Math.floor(Math.random() * tips.length)];
		stream.markdown(tip + '\n\n*Send a message to get another GitHub Copilot tip.*');
		return {};
	}
}
