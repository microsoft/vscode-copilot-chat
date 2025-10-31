/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, TextEditor, window } from 'vscode';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { copilotOutputLogTelemetry } from '../../../lib/src/snippy/telemetryHandlers';
import { citationsChannelName } from './outputChannel';

export class CodeRefEngagementTracker {
	private activeLog = false;
	private subscriptions: Disposable[] = [];

	constructor(@IInstantiationService private instantiationService: IInstantiationService) { }

	register() {
		const activeEditorChangeSub = window.onDidChangeActiveTextEditor(this.onActiveEditorChange);
		const visibleEditorsSub = window.onDidChangeVisibleTextEditors(this.onVisibleEditorsChange);

		this.subscriptions.push(visibleEditorsSub);
		this.subscriptions.push(activeEditorChangeSub);
	}

	onActiveEditorChange = (editor: TextEditor | undefined) => {
		if (this.isOutputLog(editor)) {
			copilotOutputLogTelemetry.handleFocus({ instantiationService: this.instantiationService });
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
			copilotOutputLogTelemetry.handleOpen({ instantiationService: this.instantiationService });
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

export function registerCodeRefEngagementTracker(instantiationService: IInstantiationService) {
	const engagementTracker = instantiationService.createInstance(CodeRefEngagementTracker);
	engagementTracker.register();

	return engagementTracker;
}
