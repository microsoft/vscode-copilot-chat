/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export const ITerminalService = createServiceIdentifier<ITerminalService>('ITerminalService');

export interface ITerminalService {

	readonly _serviceBrand: undefined;

	readonly terminalBuffer: string;

	readonly terminalLastCommand: vscode.TerminalExecutedCommand | undefined;

	readonly terminalSelection: string;

	readonly terminalShellType: string;

	readonly onDidChangeTerminalShellIntegration: vscode.Event<vscode.TerminalShellIntegrationChangeEvent>;
	readonly onDidEndTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
	readonly onDidCloseTerminal: vscode.Event<vscode.Terminal>;
	readonly onDidWriteTerminalData: vscode.Event<vscode.TerminalDataWriteEvent>;

	/**
	 * See {@link vscode.window.createTerminal}.
	 */
	createTerminal(name?: string, shellPath?: string, shellArgs?: readonly string[] | string): vscode.Terminal;
	createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
	createTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal;

	/**
	 * Returns the current working directory of the non-background Copilot terminal for the given session.
	 * If there are multiple Copilot terminals, the active one will be used.
	 * If there are multiple Copilot terminals and none are active, undefined will be returned.
	 * @param sessionId The session ID to get the current working directory for
	 * @returns Promise resolving to the current working directory of the Copilot terminal
	 */
	getCwdForSession(sessionId?: string): Promise<vscode.Uri | undefined>;

	/**
	 * Gets the non-background terminal and its shell integration quality for a specific session ID.
	 * @param sessionId The session ID to get the terminal for
	 * @returns Promise resolving to a terminal and its shell integration quality
	 */
	getToolTerminalForSession(sessionId: string): Promise<{ terminal: vscode.Terminal; shellIntegrationQuality: ShellIntegrationQuality } | undefined>;

	/**
	 *
	 * @param terminal The terminal to associate with the session
	 * @param sessionId The session ID to associate the terminal with
	 * @param id The ID of the terminal
	 * @param shellIntegrationQuality The shell integration quality of the terminal
	 * @param isBackground Whether the terminal is a background terminal
	 * @returns Promise resolving when the terminal is associated with the session
	 */
	associateTerminalWithSession(terminal: vscode.Terminal, sessionId: string, id: string, shellIntegrationQuality: ShellIntegrationQuality, isBackground?: boolean): Promise<void>;

	/**
	 * Gets non-background terminals associated with a specific session ID
	 * If none is provided, the current session will be used.
	 * @param sessionId The session ID to get terminals for
	 * @param includeBackground Whether to include background terminals in the result
	 * @returns Promise resolving to an array of terminals associated with the session
	 */
	getCopilotTerminals(sessionId?: string, includeBackground?: boolean): Promise<IKnownTerminal[]>;

	/**
	 * Gets the buffer for a terminal.
	 * @param maxChars The maximum number of chars to return from the buffer, defaults to 16k
	 */
	getBufferForTerminal(terminal: vscode.Terminal, maxChars?: number): string;

	/**
	 * Gets the last command executed in a terminal.
	 * @param terminal The terminal to get the last command for
	 */
	getLastCommandForTerminal(terminal: vscode.Terminal): vscode.TerminalExecutedCommand | undefined;

	readonly terminals: readonly vscode.Terminal[];
}

export const enum ShellIntegrationQuality {
	None = 'none',
	Basic = 'basic',
	Rich = 'rich',
}


export class NullTerminalService extends Disposable implements ITerminalService {
	private _onDidWriteTerminalData = this._register(new Emitter<vscode.TerminalDataWriteEvent>());
	onDidWriteTerminalData: Event<vscode.TerminalDataWriteEvent> = this._onDidWriteTerminalData.event;
	private _onDidChangeTerminalShellIntegration = this._register(new Emitter<vscode.TerminalShellIntegrationChangeEvent>());
	onDidChangeTerminalShellIntegration: Event<vscode.TerminalShellIntegrationChangeEvent> = this._onDidChangeTerminalShellIntegration.event;
	private _onDidEndTerminalShellExecution = this._register(new Emitter<vscode.TerminalShellExecutionEndEvent>());
	onDidEndTerminalShellExecution: Event<vscode.TerminalShellExecutionEndEvent> = this._onDidEndTerminalShellExecution.event;
	private _onDidCloseTerminal = this._register(new Emitter<vscode.Terminal>());
	onDidCloseTerminal: Event<vscode.Terminal> = this._onDidCloseTerminal.event;

	declare readonly _serviceBrand: undefined;

	static readonly Instance = new NullTerminalService();

	get terminalBuffer(): string {
		return '';
	}

	get terminalLastCommand(): vscode.TerminalExecutedCommand | undefined {
		return undefined;
	}

	get terminalSelection(): string {
		return '';
	}

	get terminalShellType(): string {
		return '';
	}

	async getCwdForSession(sessionId: string): Promise<vscode.Uri | undefined> {
		return Promise.resolve(undefined);
	}

	async getCopilotTerminals(sessionId: string): Promise<IKnownTerminal[]> {
		return Promise.resolve([]);
	}

	getTerminalsWithSessionInfo(): Promise<{ terminal: IKnownTerminal; sessionId: string; shellIntegrationQuality: ShellIntegrationQuality }[]> {
		throw new Error('Method not implemented.');
	}

	getToolTerminalForSession(sessionId: string): Promise<{ terminal: IKnownTerminal; shellIntegrationQuality: ShellIntegrationQuality } | undefined> {
		throw new Error('Method not implemented.');
	}

	async associateTerminalWithSession(terminal: vscode.Terminal, sessionId: string, shellIntegrationquality: ShellIntegrationQuality): Promise<void> {
		Promise.resolve();
	}

	createTerminal(name?: string, shellPath?: string, shellArgs?: readonly string[] | string): vscode.Terminal;
	createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
	createTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal;
	createTerminal(name?: any, shellPath?: any, shellArgs?: any): vscode.Terminal {
		return {} as vscode.Terminal;
	}

	get terminals(): readonly vscode.Terminal[] {
		return [];
	}

	getBufferForTerminal(terminal: vscode.Terminal, maxLines?: number): string {
		return '';
	}

	getLastCommandForTerminal(terminal: vscode.Terminal): vscode.TerminalExecutedCommand | undefined {
		return undefined;
	}
}
export function isTerminalService(thing: any): thing is ITerminalService {
	return thing && typeof thing.createTerminal === 'function';
}
export function isNullTerminalService(thing: any): thing is NullTerminalService {
	return thing && typeof thing.createTerminal === 'function' && thing.createTerminal() === undefined;
}

export interface IKnownTerminal extends vscode.Terminal {
	id: string;
}