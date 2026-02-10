/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Terminal, window } from 'vscode';
import { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { createDecorator } from '../../../../util/vs/platform/instantiation/common/instantiation';

export const ICopilotCLISessionTracker = createDecorator<ICopilotCLISessionTracker>('ICopilotCLISessionTracker');

export interface SessionProcessInfo {
	readonly pid: number;
	readonly ppid: number;
}

export interface ICopilotCLISessionTracker {
	readonly _serviceBrand: undefined;
	/**
	 * Record the PID and PPID for a newly connected session.
	 * Returns a disposable that removes the session when disposed.
	 */
	registerSession(sessionId: string, info: SessionProcessInfo): IDisposable;

	/**
	 * Get the terminal associated with a session.
	 * Returns `undefined` if no matching terminal is found.
	 */
	getTerminal(sessionId: string): Promise<Terminal | undefined>;
}

export class CopilotCLISessionTracker implements ICopilotCLISessionTracker {
	declare _serviceBrand: undefined;
	private readonly _sessions = new Map<string, SessionProcessInfo>();

	registerSession(sessionId: string, info: SessionProcessInfo): IDisposable {
		this._sessions.set(sessionId, info);
		return {
			dispose: () => {
				this._sessions.delete(sessionId);
			}
		};
	}

	async getTerminal(sessionId: string): Promise<Terminal | undefined> {
		const info = this._sessions.get(sessionId);
		if (!info) {
			return undefined;
		}

		const terminalPids = window.terminals.map(t => t.processId.then(pid => ({ terminal: t, pid })));

		for (const promise of terminalPids) {
			try {
				const { terminal, pid } = await promise;
				if (pid === info.ppid) {
					return terminal;
				}
			} catch {
				//
			}
		}

		return undefined;
	}
}
