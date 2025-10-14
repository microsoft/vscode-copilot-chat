/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { isLocation } from '../../../util/common/types';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { localize } from '../../../util/vs/nls';
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { buildChatHistoryFromEvents, parseChatMessagesToEvents } from '../../agents/copilotcli/node/copilotcliToolInvocationFormatter';

export class CopilotCLIChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	constructor(
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService,
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);

		if (enabled) {
			this.setupCopilotCLIPath();
		}
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = sessions.map(session => ({
			id: session.id,
			label: session.label,
			tooltip: `Copilot CLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			iconPath: new vscode.ThemeIcon('terminal')
		} satisfies vscode.ChatSessionItem));

		return diskSessions;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
		await this.createAndExecuteInTerminal(terminalName, 'copilot');
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const terminalName = `Copilot CLI - ${sessionItem.label || sessionItem.id}`;
		const command = `copilot --resume ${sessionItem.id}`;
		await this.createAndExecuteInTerminal(terminalName, command);
	}

	private async setupCopilotCLIPath(): Promise<void> {
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli');
		const copilotPackageIndexJs = path.join(this.context.extensionPath, 'node_modules', '@github', 'copilot', 'index.js');

		try {
			await fs.access(copilotPackageIndexJs);
			await fs.mkdir(storageLocation, { recursive: true });

			// Note: node-pty shim is created in agent manager before first SDK import
			// This allows @github/copilot to import node-pty before extension activation

			if (process.platform === 'win32') {
				// Windows: Create batch file
				const batPath = path.join(storageLocation, 'copilot.bat');
				const batScript = `@echo off\nnode "${copilotPackageIndexJs}" %*`;
				await fs.writeFile(batPath, batScript);
			} else {
				// Unix: Create shell script
				const shPath = path.join(storageLocation, 'copilot');
				const shScript = `#!/bin/sh\nnode "${copilotPackageIndexJs}" "$@"`;
				await fs.writeFile(shPath, shScript);
				await fs.chmod(shPath, 0o755);
			}

			// Contribute the storage location to PATH
			this.terminalService.contributePath('copilot-cli', storageLocation, 'Enables use of the `copilot` command in the terminal.');
		} catch {
			// @github/copilot package not found, no need to add to PATH
		}
	}


	private async createAndExecuteInTerminal(terminalName: string, command: string): Promise<void> {
		const existingTerminal = vscode.window.terminals.find(t => t.name === terminalName);
		if (existingTerminal) {
			existingTerminal.show();
			return;
		}

		const session = await this._authenticationService.getAnyGitHubSession();
		if (session) {
			this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
		}

		const terminal = vscode.window.createTerminal({
			name: terminalName,
			iconPath: new vscode.ThemeIcon('terminal'),
			location: { viewColumn: vscode.ViewColumn.Active }
		});

		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000;
		let shellIntegrationAvailable = false;

		const integrationPromise = new Promise<void>((resolve) => {
			const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal && e.shellIntegration) {
					shellIntegrationAvailable = true;
					disposable.dispose();
					resolve();
				}
			});

			setTimeout(() => {
				disposable.dispose();
				resolve();
			}, shellIntegrationTimeout);
		});

		terminal.show();
		await integrationPromise;

		if (shellIntegrationAvailable && terminal.shellIntegration) {
			// TODO@rebornix fix in VS Code
			await new Promise(resolve => setTimeout(resolve, 500)); // Wait a bit to ensure the terminal is ready
			terminal.shellIntegration.executeCommand(command);
		} else {
			terminal.sendText(command);
		}
	}
}

export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) { }

	async provideChatSessionContent(copilotcliSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = copilotcliSessionId && await this.sessionService.getSession(copilotcliSessionId, token);
		const sdkSession = existingSession ? existingSession.sdkSession : undefined;
		const chatMessages = sdkSession?.chatMessages || [];
		const events = parseChatMessagesToEvents(chatMessages);

		const history = existingSession ? buildChatHistoryFromEvents(events) : [];

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
		};
	}
}

export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly copilotcliAgentManager: CopilotCLIAgentManager,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		// Resolve the prompt with references before processing
		const resolvedPrompt = this.resolvePrompt(request);
		const processedRequest = { ...request, prompt: resolvedPrompt };

		const create = async () => {
			const { copilotcliSessionId } = await this.copilotcliAgentManager.handleRequest(undefined, processedRequest, context, stream, token);
			if (!copilotcliSessionId) {
				stream.warning(localize('copilotcli.failedToCreateSession', "Failed to create a new CopilotCLI session."));
				return undefined;
			}
			return copilotcliSessionId;
		};
		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				const copilotcliSessionId = await create();
				if (copilotcliSessionId) {
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: copilotcliSessionId, label: processedRequest.prompt ?? 'CopilotCLI' });
				}
				return {};
			}

			const { id } = chatSessionContext.chatSessionItem;
			await this.copilotcliAgentManager.handleRequest(id, processedRequest, context, stream, token);
			return {};
		}

		stream.markdown(localize('copilotcli.viaAtCopilotcli', "Start a new CopilotCLI session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('copilotcli.startNewSession', "Start Session") });
		return {};
	}

	private resolvePrompt(request: vscode.ChatRequest): string {
		if (request.prompt.startsWith('/')) {
			return request.prompt; // likely a slash command, don't modify
		}

		const allRefsTexts: string[] = [];
		const prompt = request.prompt;
		request.references.forEach(ref => {
			const valueText = URI.isUri(ref.value) ?
				ref.value.fsPath :
				isLocation(ref.value) ?
					`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
					undefined;
			if (valueText) {
				// Keep the original prompt untouched, just collect resolved paths
				const variableText = ref.range ? prompt.substring(ref.range[0], ref.range[1]) : undefined;
				if (variableText) {
					allRefsTexts.push(`- ${variableText} → ${valueText}`);
				} else {
					allRefsTexts.push(`- ${valueText}`);
				}
			}
		});

		if (allRefsTexts.length > 0) {
			return `<system-reminder>\nThe user provided the following references:\n${allRefsTexts.join('\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n${prompt}`;
		}

		return prompt;
	}
}

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService): IDisposable {
	const disposableStore = new DisposableStore();
	disposableStore.add(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.id) {
			const result = await vscode.window.showWarningMessage(
				`Are you sure you want to delete the session?`,
				{ modal: true },
				'Delete',
				'Cancel'
			);

			if (result === 'Delete') {
				await copilotCLISessionService.deleteSession(sessionItem.id);
			}
		}
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.resumeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.id) {
			await copilotcliSessionItemProvider.resumeCopilotCLISessionInTerminal(sessionItem);
		}
	}));

	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.newTerminalSession', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal();
	}));
	return disposableStore;
}