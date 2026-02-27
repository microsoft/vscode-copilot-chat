/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, chat, commands, debug, DebugAdapterDescriptor, DebugAdapterDescriptorFactory, DebugAdapterInlineImplementation, DebugConfiguration, DebugConfigurationProvider, DebugSession, NotebookDocument, ProviderResult, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CHAT_REPLAY_NOTEBOOK_TYPE, ChatReplayNotebookSerializer } from './chatReplayNotebookSerializer';
import { ChatReplayParticipant } from './chatReplayParticipant';
import { ChatReplaySessionProvider } from './chatReplaySessionProvider';
import { ChatReplayDebugSession } from './replayDebugSession';

export class ChatReplayContribution extends Disposable {

	private _sessionProvider: ChatReplaySessionProvider;
	/** Tracks notebooks that have already had their cells collapsed on open */
	private readonly _collapsedNotebooks = new Set<string>();

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._sessionProvider = this._register(new ChatReplaySessionProvider());

		const replayParticipant = this._instantiationService.createInstance(ChatReplayParticipant);
		const chatParticipant = chat.createChatParticipant('github.copilot.chatReplay', replayParticipant.handleRequest.bind(replayParticipant));
		this._register(chat.registerChatSessionContentProvider('chat-replay', this._sessionProvider, chatParticipant));

		// Register notebook serializer for .chatreplay.json files
		this._register(workspace.registerNotebookSerializer(
			CHAT_REPLAY_NOTEBOOK_TYPE,
			new ChatReplayNotebookSerializer(),
			{ transientOutputs: true }
		));

		const provider = new ChatReplayConfigProvider();
		this._register(debug.registerDebugConfigurationProvider('vscode-chat-replay', provider));

		const factory = new InlineDebugAdapterFactory();
		this._register(debug.registerDebugAdapterDescriptorFactory('vscode-chat-replay', factory));
		this.registerStartReplayCommand();
		this.registerEnableWorkspaceEditTracingCommand();
		this.registerDisableWorkspaceEditTracingCommand();

		commands.executeCommand('setContext', 'github.copilot.chat.replay.workspaceEditTracing', false);

		this.registerDisplayChatFromLogCommand();
		this.registerNotebookCellCollapseListener();
	}

	private registerDisplayChatFromLogCommand() {
		this._register(commands.registerCommand('github.copilot.chat.showAsChatSession', async (logFilePath: Uri) => {
			const replayUri = logFilePath.with({ scheme: 'chat-replay' });
			await commands.executeCommand('vscode.open', replayUri);
		}));
	}

	/**
	 * Registers a listener that collapses cells with `collapsed: true` metadata
	 * when a chat replay notebook is opened.
	 */
	private registerNotebookCellCollapseListener() {
		// Listen for notebook documents being opened - this fires after deserialization completes
		this._register(workspace.onDidOpenNotebookDocument(notebook => {
			if (notebook.notebookType === CHAT_REPLAY_NOTEBOOK_TYPE) {
				// Small delay to ensure the editor is ready to receive commands
				setTimeout(() => this.collapseCellsIfNeeded(notebook), 1000);
			}
		}));

		// Remove from tracking when notebook is closed so cells collapse again on reopen
		this._register(workspace.onDidCloseNotebookDocument(notebook => {
			if (notebook.notebookType === CHAT_REPLAY_NOTEBOOK_TYPE) {
				this._collapsedNotebooks.delete(notebook.uri.toString());
			}
		}));
	}

	/**
	 * Collapses cells marked with `collapsed: true` metadata in a chat replay notebook.
	 */
	private async collapseCellsIfNeeded(notebook: NotebookDocument): Promise<void> {
		// Only collapse cells once per notebook (on first open)
		const notebookKey = notebook.uri.toString();
		if (this._collapsedNotebooks.has(notebookKey)) {
			return;
		}
		this._collapsedNotebooks.add(notebookKey);

		// Collect ranges of cells with collapsed metadata
		const ranges: { start: number; end: number }[] = [];
		for (let i = 0; i < notebook.cellCount; i++) {
			const cell = notebook.cellAt(i);
			if (cell.metadata?.collapsed === true) {
				ranges.push({ start: i, end: i + 1 });
			}
		}

		// Collapse all cells in a single command call
		if (ranges.length > 0) {
			await commands.executeCommand('notebook.cell.collapseCellInput', { ranges });
		}
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
			return window.showInformationMessage('Cannot find a program to debug').then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}
