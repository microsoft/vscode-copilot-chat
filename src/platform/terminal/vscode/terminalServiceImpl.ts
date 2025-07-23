/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, ExtensionTerminalOptions, Terminal, TerminalExecutedCommand, TerminalOptions, TerminalShellExecutionEndEvent, TerminalShellIntegrationChangeEvent, window, type TerminalDataWriteEvent } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ITerminalService } from '../common/terminalService';
import { getActiveTerminalBuffer, getActiveTerminalLastCommand, getActiveTerminalSelection, getActiveTerminalShellType, getBufferForTerminal, getLastCommandForTerminal, installTerminalBufferListeners } from './terminalBufferListener';

export class TerminalServiceImpl extends Disposable implements ITerminalService {

	declare readonly _serviceBrand: undefined;

	constructor() {
		super();
		for (const l of installTerminalBufferListeners()) {
			this._register(l);
		}
	}

	get terminals(): readonly Terminal[] {
		return window.terminals;
	}

	get onDidChangeTerminalShellIntegration(): Event<TerminalShellIntegrationChangeEvent> {
		return window.onDidChangeTerminalShellIntegration;
	}

	get onDidEndTerminalShellExecution(): Event<TerminalShellExecutionEndEvent> {
		return window.onDidEndTerminalShellExecution;
	}

	get onDidCloseTerminal(): Event<Terminal> {
		return window.onDidCloseTerminal;
	}
	get onDidWriteTerminalData(): Event<TerminalDataWriteEvent> {
		return window.onDidWriteTerminalData;
	}

	createTerminal(name?: string, shellPath?: string, shellArgs?: readonly string[] | string): Terminal;
	createTerminal(options: TerminalOptions): Terminal;
	createTerminal(options: ExtensionTerminalOptions): Terminal;
	createTerminal(name?: any, shellPath?: any, shellArgs?: any): Terminal {
		const terminal = window.createTerminal(name, shellPath, shellArgs);
		return terminal;
	}

	getBufferForTerminal(terminal: Terminal, maxChars?: number): string {
		return getBufferForTerminal(terminal, maxChars);
	}

	async getBufferWithPid(pid: number, maxChars?: number): Promise<string> {
		let terminal: Terminal | undefined;
		for (const t of this.terminals) {
			const tPid = await t.processId;
			if (tPid === pid) {
				terminal = t;
				break;
			}
		}
		if (terminal) {
			return this.getBufferForTerminal(terminal, maxChars);
		}
		return '';
	}

	getLastCommandForTerminal(terminal: Terminal): TerminalExecutedCommand | undefined {
		return getLastCommandForTerminal(terminal);
	}

	get terminalBuffer(): string {
		return getActiveTerminalBuffer();
	}

	get terminalLastCommand(): TerminalExecutedCommand | undefined {
		return getActiveTerminalLastCommand();
	}

	get terminalSelection(): string {
		return getActiveTerminalSelection();
	}

	get terminalShellType(): string {
		return getActiveTerminalShellType();
	}
}