/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken } from 'vscode';
import { createDecorator, IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { getClaudeSlashCommandRegistry, IClaudeSlashCommandHandler } from './slashCommands/claudeSlashCommandRegistry';

// Import all slash command handlers to trigger self-registration
import './slashCommands/index';

export interface IClaudeSlashCommandResult {
	handled: boolean;
	result?: vscode.ChatResult;
}

export interface IClaudeSlashCommandService {
	readonly _serviceBrand: undefined;

	/**
	 * Try to handle a slash command from the user's prompt.
	 *
	 * @param prompt - The user's full prompt (e.g., "/hooks event")
	 * @param stream - Response stream for sending messages to the chat
	 * @param token - Cancellation token
	 * @returns Object indicating whether the command was handled and the result
	 */
	tryHandleCommand(
		prompt: string,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
	): Promise<IClaudeSlashCommandResult>;

	/**
	 * Get all registered command names.
	 */
	getRegisteredCommands(): readonly string[];
}

export const IClaudeSlashCommandService = createDecorator<IClaudeSlashCommandService>('claudeSlashCommandService');

export class ClaudeSlashCommandService implements IClaudeSlashCommandService {
	readonly _serviceBrand: undefined;

	private _handlerCache = new Map<string, IClaudeSlashCommandHandler>();
	private _commandDisposables: vscode.Disposable[] = [];
	private _initialized = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		// Initialize eagerly to register VS Code commands at startup
		this._ensureInitialized();
	}

	async tryHandleCommand(
		prompt: string,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
	): Promise<IClaudeSlashCommandResult> {
		// Parse the prompt for a slash command pattern: /commandName [args]
		const match = prompt.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
		if (!match) {
			return { handled: false };
		}

		const [, commandName, args] = match;
		const handler = this._getHandler(commandName.toLowerCase());
		if (!handler) {
			return { handled: false };
		}

		const result = await handler.handle(args ?? '', stream, token);
		return { handled: true, result: result ?? {} };
	}

	getRegisteredCommands(): readonly string[] {
		this._ensureInitialized();
		return Array.from(this._handlerCache.keys());
	}

	private _getHandler(commandName: string): IClaudeSlashCommandHandler | undefined {
		this._ensureInitialized();
		return this._handlerCache.get(commandName);
	}

	private _ensureInitialized(): void {
		if (this._initialized) {
			return;
		}

		// Instantiate all registered handlers and cache them by command name
		const ctors = getClaudeSlashCommandRegistry();
		for (const ctor of ctors) {
			const handler = this.instantiationService.createInstance(ctor);
			this._handlerCache.set(handler.commandName.toLowerCase(), handler);

			// Register VS Code command if commandId is provided
			if (handler.commandId) {
				const disposable = vscode.commands.registerCommand(handler.commandId, () => {
					// Invoke with no args, no stream (Command Palette mode), and a cancellation token
					const tokenSource = new vscode.CancellationTokenSource();
					handler.handle('', undefined, tokenSource.token).catch(err => {
						vscode.window.showErrorMessage(`Command failed: ${err.message || err}`);
					});
				});
				this._commandDisposables.push(disposable);
			}
		}

		this._initialized = true;
	}

	dispose(): void {
		for (const disposable of this._commandDisposables) {
			disposable.dispose();
		}
		this._commandDisposables = [];
	}
}
