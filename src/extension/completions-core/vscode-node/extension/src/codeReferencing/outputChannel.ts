/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken } from '../../../lib/src/auth/copilotTokenManager';
import { onCopilotToken } from '../../../lib/src/auth/copilotTokenNotifier';
import { Context } from '../../../lib/src/context';
import { Disposable, window, type OutputChannel } from 'vscode';

interface GitHubLogger extends Disposable {
	info(...messages: string[]): void;
	forceShow(): void;
}

export const citationsChannelName = 'GitHub Copilot Log (Code References)';

// Literally taken from VS Code
function getCurrentTimestamp() {
	const toTwoDigits = (v: number) => (v < 10 ? `0${v}` : v);
	const toThreeDigits = (v: number) => (v < 10 ? `00${v}` : v < 100 ? `0${v}` : v);
	const currentTime = new Date();
	return `${currentTime.getFullYear()}-${toTwoDigits(currentTime.getMonth() + 1)}-${toTwoDigits(
		currentTime.getDate()
	)} ${toTwoDigits(currentTime.getHours())}:${toTwoDigits(currentTime.getMinutes())}:${toTwoDigits(
		currentTime.getSeconds()
	)}.${toThreeDigits(currentTime.getMilliseconds())}`;
}

class CodeReferenceOutputChannel {
	constructor(private output: OutputChannel) { }

	info(...messages: string[]) {
		this.output.appendLine(`${getCurrentTimestamp()} [info] ${messages.join(' ')}`);
	}

	show(preserveFocus: boolean) {
		this.output.show(preserveFocus);
	}

	dispose() {
		this.output.dispose();
	}
}

export class GitHubCopilotLogger implements GitHubLogger {
	private output: CodeReferenceOutputChannel;
	#event: Disposable;

	static create(ctx: Context) {
		return new GitHubCopilotLogger(ctx);
	}

	protected constructor(ctx: Context) {
		this.#event = onCopilotToken(ctx, t => this.checkCopilotToken(t));

		this.output = this.createChannel();
	}

	private checkCopilotToken = (token: Omit<CopilotToken, "token">) => {
		if (token.codeQuoteEnabled) {
			this.output = this.createChannel();
		} else {
			this.output?.dispose();
		}
	};

	private createChannel() {
		if (this.output) {
			return this.output;
		}

		return new CodeReferenceOutputChannel(window.createOutputChannel(citationsChannelName, 'code-referencing'));
	}

	private log(type: 'info', ...messages: string[]) {
		if (!this.output) {
			this.output = this.createChannel();
		}

		const [base, ...rest] = messages;
		this.output[type](base, ...rest);
	}

	info(...messages: string[]) {
		this.log('info', ...messages);
	}

	forceShow() {
		// Preserve focus in the editor
		this.output?.show(true);
	}

	dispose() {
		this.output?.dispose();
		this.#event.dispose();
	}
}
