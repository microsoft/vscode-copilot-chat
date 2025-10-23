/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, LanguageStatusItem, LanguageStatusSeverity } from 'vscode';
import { Context } from '../../lib/src/context';
import { CMDQuotaExceeded } from '../../lib/src/openai/fetch';
import { StatusChangedEvent, StatusReporter } from '../../lib/src/progress';
import { isCompletionEnabled, isInlineSuggestEnabled } from './config';
import { CMDToggleStatusMenu } from './constants';
import { CopilotExtensionStatus } from './extensionStatus';
import { Icon } from './icon';

export class CopilotStatusBar extends StatusReporter { // TODO: proper disposal
	readonly item!: LanguageStatusItem;
	showingMessage = false;
	state!: CopilotExtensionStatus;
	private disposables: Disposable[] = [];

	constructor(
		private readonly ctx: Context,
		id = 'github.copilot.languageStatus'
	) {
		super();

		this.state = ctx.get(CopilotExtensionStatus);
		/*  this.item = languages.createLanguageStatusItem(id, '*');
		 this.disposables.push(this.item);

		 this.updateStatusBarIndicator();

		 this.disposables.push(
			 window.onDidChangeActiveTextEditor(() => {
				 this.updateStatusBarIndicator();
			 })
		 );

		 this.disposables.push(
			 workspace.onDidCloseTextDocument(() => {
				 this.updateStatusBarIndicator();
			 })
		 );

		 this.disposables.push(
			 workspace.onDidOpenTextDocument(() => {
				 this.updateStatusBarIndicator();
			 })
		 );

		 this.disposables.push(
			 workspace.onDidChangeConfiguration(e => {
				 if (!e.affectsConfiguration(CopilotConfigPrefix)) { return; }
				 this.updateStatusBarIndicator();
			 })
		 ); */
	}

	override didChange(event: StatusChangedEvent): void {
		this.state.kind = event.kind;
		this.state.message = event.message;
		this.state.command = event.command;
		//this.updateStatusBarIndicator();
	}

	private checkEnabledForLanguage(): boolean {
		return isCompletionEnabled(this.ctx) ?? true;
	}

	protected updateStatusBarIndicator() {
		if (this.isDisposed()) {
			return;
		}
		void commands.executeCommand(
			'setContext',
			'github.copilot.completions.quotaExceeded',
			this.state.command?.command === CMDQuotaExceeded
		);
		const enabled = this.checkEnabledForLanguage();
		void commands.executeCommand('setContext', 'github.copilot.completions.enabled', enabled);
		this.item.command = { command: CMDToggleStatusMenu, title: 'View Details' };
		switch (this.state.kind) {
			case 'Error':
				this.item.severity = LanguageStatusSeverity.Error;
				this.item.text = `${Icon.Warning} Completions`;
				this.item.detail = 'Error';
				break;
			case 'Warning':
				this.item.severity = LanguageStatusSeverity.Warning;
				this.item.text = `${Icon.Warning} Completions`;
				this.item.detail = 'Temporary issues';
				break;
			case 'Inactive':
				this.item.severity = LanguageStatusSeverity.Information;
				this.item.text = `${Icon.Blocked} Completions`;
				this.item.detail = 'Inactive';
				break;
			case 'Normal':
				this.item.severity = LanguageStatusSeverity.Information;
				if (!isInlineSuggestEnabled()) {
					this.item.text = `${Icon.NotConnected} Completions`;
					this.item.detail = 'VS Code inline suggestions disabled';
				} else if (!enabled) {
					this.item.text = `${Icon.NotConnected} Completions`;
					this.item.detail = 'Disabled';
				} else {
					this.item.text = `${Icon.Logo} Completions`;
					this.item.detail = '';
				}
				this.item.command.title = 'Open Menu';
				break;
		}
		this.item.accessibilityInformation = {
			label: 'Copilot Completions',
		};
		if (this.state.command) {
			this.item.command = this.state.command;
			this.item.detail = this.state.message;
		}
	}

	dispose() {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}

	private isDisposed() {
		return this.disposables.length === 0;
	}
}
