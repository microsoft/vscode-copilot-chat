/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, commands, debug, DebugAdapterDescriptor, DebugAdapterDescriptorFactory, DebugAdapterInlineImplementation, DebugConfiguration, DebugConfigurationProvider, DebugSession, ProviderResult, window, WorkspaceFolder } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatReplayDebugSession } from './replayDebugSession';

export class ChatReplayContribution extends Disposable {
	constructor() {
		super();

		const provider = new ChatReplayConfigProvider();
		this._register(debug.registerDebugConfigurationProvider('vscode-chat-replay', provider));

		const factory = new InlineDebugAdapterFactory();
		this._register(debug.registerDebugAdapterDescriptorFactory('vscode-chat-replay', factory));
		this.registerStartReplayCommand();
	}

	private registerStartReplayCommand() {
		this._register(commands.registerCommand('github.copilot.chat.replay', async () => {
			const editor = window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'chatReplay') {
				window.showInformationMessage('Open a chat replay file to debug.');
				return;
			}

			const debugConfig: DebugConfiguration = {
				type: 'vscode-chat-replay',
				name: 'Debug Chat Replay',
				request: 'launch',
				program: editor.document.uri.fsPath,
				stopOnEntry: true
			};
			await debug.startDebugging(undefined, debugConfig);

		}));
	}
}

class InlineDebugAdapterFactory implements DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(session: DebugSession): ProviderResult<DebugAdapterDescriptor> {
		return new DebugAdapterInlineImplementation(new ChatReplayDebugSession(session.workspaceFolder));
	}
}

export class ChatReplayConfigProvider implements DebugConfigurationProvider {

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = window.activeTextEditor;
			if (editor && editor.document.languageId === 'chatReplay') {
				config.type = 'vscode-chat-replay';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}
