/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../../lib/src/context';
import { copilotOutputLogTelemetry } from '../../../lib/src/snippy/telemetryHandlers';
import { Disposable, TextEditor, window } from 'vscode';
import { citationsChannelName } from './outputChannel';

class CodeRefEngagementTracker {
	private activeLog = false;
	private subscriptions: Disposable[] = [];

	constructor(private ctx: Context) { }

	register() {
		const activeEditorChangeSub = window.onDidChangeActiveTextEditor(this.onActiveEditorChange);
		const visibleEditorsSub = window.onDidChangeVisibleTextEditors(this.onVisibleEditorsChange);

		this.subscriptions.push(visibleEditorsSub);
		this.subscriptions.push(activeEditorChangeSub);
	}

	onActiveEditorChange = (editor: TextEditor | undefined) => {
		if (this.isOutputLog(editor)) {
			copilotOutputLogTelemetry.handleFocus({ context: this.ctx });
		}
	};

	onVisibleEditorsChange = (currEditors: readonly TextEditor[]) => {
		const copilotLog = currEditors.find(this.isOutputLog);

		if (this.activeLog) {
			if (!copilotLog) {
				this.activeLog = false;
			}
		} else if (copilotLog) {
			this.activeLog = true;
			copilotOutputLogTelemetry.handleOpen({ context: this.ctx });
		}
	};

	dispose() {
		for (const sub of this.subscriptions) {
			sub.dispose();
		}
		this.subscriptions = [];
	}

	get logVisible() {
		return this.activeLog;
	}

	private isOutputLog = (editor: TextEditor | undefined) => {
		return (
			editor && editor.document.uri.scheme === 'output' && editor.document.uri.path.includes(citationsChannelName)
		);
	};
}

export function registerCodeRefEngagementTracker(ctx: Context) {
	const engagementTracker = new CodeRefEngagementTracker(ctx);
	engagementTracker.register();

	return engagementTracker;
}
