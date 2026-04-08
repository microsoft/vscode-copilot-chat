/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type * as vscode from 'vscode';
import { type RefRow, type SessionRow, ISessionStore } from '../../../platform/chronicle/common/sessionStore';
import { SessionStore } from '../../../platform/chronicle/node/sessionStore';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { type AnnotatedRef, type AnnotatedSession, type SessionFileInfo, type SessionTurnInfo, SESSIONS_QUERY_SQLITE, buildFilesQuery, buildRefsQuery, buildStandupPrompt, buildTurnsQuery } from '../../chronicle/common/standupPrompt';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IStandupToolParams { }

export class StandupTool implements ICopilotTool<IStandupToolParams> {
	public static readonly toolName = ToolName.ChronicleStandup;

	constructor(
		@ISessionStore private readonly sessionStore: ISessionStore,
	) { }

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<IStandupToolParams>, _token: CancellationToken) {
		// Query VS Code's local session store
		const vscodeSessions = this._queryStore(this.sessionStore, 'vscode');

		// Query CLI's session store if it exists
		const cliSessions = this._queryCliStore();

		const sessions: AnnotatedSession[] = [...vscodeSessions.sessions, ...cliSessions.sessions];
		const refs: AnnotatedRef[] = [...vscodeSessions.refs, ...cliSessions.refs];
		const files: SessionFileInfo[] = [...vscodeSessions.files, ...cliSessions.files];
		const turns: SessionTurnInfo[] = [...vscodeSessions.turns, ...cliSessions.turns];
		sessions.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

		const prompt = buildStandupPrompt(sessions, refs, undefined, files, turns);

		const vscodeCount = vscodeSessions.sessions.length;
		const cliCount = cliSessions.sessions.length;
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(prompt)]);
		result.toolResultMessage = sessions.length === 0
			? new MarkdownString(l10n.t`No sessions found in the last 24 hours`)
			: new MarkdownString(l10n.t`Found ${sessions.length} session(s) from the last 24 hours (${vscodeCount} VS Code, ${cliCount} CLI)`);
		return result;
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IStandupToolParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(l10n.t`Generating standup summary...`),
		};
	}

	private _queryStore(store: ISessionStore, source: 'vscode' | 'cli'): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		try {
			const rawSessions = store.executeReadOnly(SESSIONS_QUERY_SQLITE) as unknown as SessionRow[];
			const sessions: AnnotatedSession[] = rawSessions.map(s => ({ ...s, source }));

			let refs: AnnotatedRef[] = [];
			let files: SessionFileInfo[] = [];
			let turns: SessionTurnInfo[] = [];
			if (sessions.length > 0) {
				const ids = sessions.map(s => s.id);
				const rawRefs = store.executeReadOnly(buildRefsQuery(ids)) as unknown as RefRow[];
				refs = rawRefs.map(r => ({ ...r, source }));
				files = store.executeReadOnly(buildFilesQuery(ids)) as unknown as SessionFileInfo[];
				turns = store.executeReadOnly(buildTurnsQuery(ids)) as unknown as SessionTurnInfo[];
			}

			return { sessions, refs, files, turns };
		} catch {
			return { sessions: [], refs: [], files: [], turns: [] };
		}
	}

	private _queryCliStore(): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		const cliDbPath = join(homedir(), '.copilot', 'session-store.db');
		if (!existsSync(cliDbPath)) {
			return { sessions: [], refs: [], files: [], turns: [] };
		}

		let cliStore: SessionStore | undefined;
		try {
			cliStore = new SessionStore(cliDbPath);
			return this._queryStore(cliStore, 'cli');
		} catch {
			return { sessions: [], refs: [], files: [], turns: [] };
		} finally {
			cliStore?.close();
		}
	}
}

ToolRegistry.registerTool(StandupTool);
