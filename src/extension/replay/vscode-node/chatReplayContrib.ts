/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, chat, commands, debug, DebugAdapterDescriptor, DebugAdapterDescriptorFactory, DebugAdapterInlineImplementation, DebugConfiguration, DebugConfigurationProvider, DebugSession, ProviderResult, Uri, window, WorkspaceFolder } from 'vscode';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReplayParticipant } from './chatReplayParticipant';
import { ChatReplaySessionProvider } from './chatReplaySessionProvider';
import { ChatReplayDebugSession } from './replayDebugSession';

export class ChatReplayContribution extends Disposable {

	private _sessionProvider: ChatReplaySessionProvider;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._sessionProvider = this._register(new ChatReplaySessionProvider());

		const replayParticipant = this._instantiationService.createInstance(ChatReplayParticipant);
		const chatParticipant = chat.createChatParticipant('github.copilot.chatReplay', replayParticipant.handleRequest.bind(replayParticipant));
		this._register(chat.registerChatSessionContentProvider('chat-replay', this._sessionProvider, chatParticipant));

		const provider = new ChatReplayConfigProvider();
		this._register(debug.registerDebugConfigurationProvider('vscode-chat-replay', provider));

		const factory = new InlineDebugAdapterFactory();
		this._register(debug.registerDebugAdapterDescriptorFactory('vscode-chat-replay', factory));
		this.registerStartReplayCommand();
		this.registerEnableWorkspaceEditTracingCommand();
		this.registerDisableWorkspaceEditTracingCommand();

		commands.executeCommand('setContext', 'github.copilot.chat.replay.workspaceEditTracing', false);

		this.registerDisplayChatFromLogCommand();
	}

	private registerDisplayChatFromLogCommand() {
		this._register(commands.registerCommand('github.copilot.chat.showAsChatSession', async (logFilePath: Uri) => {
			const replayUri = logFilePath.with({ scheme: 'chat-replay' });
			await commands.executeCommand('vscode.open', replayUri);
		}));
	}

	private registerStartReplayCommand() {
		this._register(commands.registerCommand('github.copilot.chat.replay', async () => {
			const editor = window.activeTextEditor;
			if (!editor) {
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

	private registerEnableWorkspaceEditTracingCommand() {
		this._register(commands.registerCommand('github.copilot.chat.replay.enableWorkspaceEditTracing', async () => {
			const logger = this._instantiationService.invokeFunction(accessor => accessor.get(IRequestLogger));
			logger.enableWorkspaceEditTracing();
			await commands.executeCommand('setContext', 'github.copilot.chat.replay.workspaceEditTracing', true);
		}));
	}

	private registerDisableWorkspaceEditTracingCommand() {
		this._register(commands.registerCommand('github.copilot.chat.replay.disableWorkspaceEditTracing', async () => {
			const logger = this._instantiationService.invokeFunction(accessor => accessor.get(IRequestLogger));
			logger.disableWorkspaceEditTracing();
			await commands.executeCommand('setContext', 'github.copilot.chat.replay.workspaceEditTracing', false);
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
