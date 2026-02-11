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
	 * Set the display name for a session (called by the CLI).
	 */
	setSessionName(sessionId: string, name: string): void;

	/**
	 * Get a display name for a session, falling back to the sessionId.
	 */
	getSessionDisplayName(sessionId: string): string;

	/**
	 * Get the IDs of all connected sessions.
	 */
	getSessionIds(): readonly string[];

	/**
	 * Get the terminal associated with a session.
	 * Returns `undefined` if no matching terminal is found.
	 */
	getTerminal(sessionId: string): Promise<Terminal | undefined>;
}

export class CopilotCLISessionTracker implements ICopilotCLISessionTracker {
	declare _serviceBrand: undefined;
	private readonly _sessions = new Map<string, SessionProcessInfo>();
	private readonly _sessionNames = new Map<string, string>();

	registerSession(sessionId: string, info: SessionProcessInfo): IDisposable {
		this._sessions.set(sessionId, info);
		return {
			dispose: () => {
				this._sessions.delete(sessionId);
				this._sessionNames.delete(sessionId);
			}
		};
	}

	setSessionName(sessionId: string, name: string): void {
		this._sessionNames.set(sessionId, name);
	}

	getSessionDisplayName(sessionId: string): string {
		return this._sessionNames.get(sessionId) ?? sessionId;
	}

	getSessionIds(): readonly string[] {
		return Array.from(this._sessions.keys());
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
