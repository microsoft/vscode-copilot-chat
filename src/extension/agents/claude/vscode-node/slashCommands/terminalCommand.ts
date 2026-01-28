/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { ITerminalService } from '../../../../../platform/terminal/common/terminalService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeLanguageModelServer } from '../../node/claudeLanguageModelServer';
import { IClaudeSlashCommandHandler, registerClaudeSlashCommand } from './claudeSlashCommandRegistry';

/**
 * Slash command handler for creating a terminal session with Claude CLI configured
 * to use Copilot Chat's endpoints.
 *
 * This command starts a ClaudeLanguageModelServer instance (if not already running)
 * and creates a new terminal with ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY environment
 * variables set to proxy requests through Copilot Chat's chat endpoints.
 *
 * ## Usage
 * 1. In a Claude Agent chat session, type `/terminal`
 * 2. A new terminal will be created with the environment variables configured
 * 3. Run `claude` in the terminal to start Claude Code
 * 4. Claude Code will use Copilot Chat's endpoints for all LLM requests
 *
 * ## Requirements
 * - Claude CLI (`claude`) must be installed and available in PATH
 * - The terminal inherits the environment with ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY set
 * - The language model server runs on localhost with a random available port
 */
 */
export class TerminalSlashCommand implements IClaudeSlashCommandHandler {
	readonly commandName = 'terminal';
	readonly description = 'Create terminal with Claude CLI using Copilot Chat endpoints';
	readonly commandId = 'copilot.claude.terminal';

	private _langModelServer: ClaudeLanguageModelServer | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async handle(
		_args: string,
		stream: vscode.ChatResponseStream | undefined,
		_token: CancellationToken
	): Promise<vscode.ChatResult> {
		stream?.markdown(vscode.l10n.t('Creating Claude CLI terminal...'));

		try {
			// Get or create the language model server
			const server = await this._getLanguageModelServer();
			const config = server.getConfig();

			// Create terminal with environment variables configured
			const terminal = this.terminalService.createTerminal({
				name: 'Claude CLI',
				env: {
					ANTHROPIC_BASE_URL: `http://localhost:${config.port}`,
					ANTHROPIC_API_KEY: config.nonce,
				}
			});

			// Show the terminal
			terminal.show();

			stream?.markdown(vscode.l10n.t('Terminal created. Run `claude` to start Claude Code with Copilot Chat endpoints.'));

			this.logService.info(`[TerminalSlashCommand] Created terminal with Claude CLI configured on port ${config.port}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error('[TerminalSlashCommand] Error creating terminal:', error);
			stream?.markdown(vscode.l10n.t('Error creating terminal: {0}', errorMessage));
		}

		return {};
	}

	private async _getLanguageModelServer(): Promise<ClaudeLanguageModelServer> {
		if (!this._langModelServer) {
			this._langModelServer = this.instantiationService.createInstance(ClaudeLanguageModelServer);
			await this._langModelServer.start();
		}

		return this._langModelServer;
	}
}

// Self-register the terminal command
registerClaudeSlashCommand(TerminalSlashCommand);
