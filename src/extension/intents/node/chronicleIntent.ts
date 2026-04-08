/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { type RefRow, type SessionRow, ISessionStore } from '../../../platform/chronicle/common/sessionStore';
import { SessionStore } from '../../../platform/chronicle/node/sessionStore';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelChatMessage } from '../../../vscodeTypes';
import { type AnnotatedRef, type AnnotatedSession, type SessionFileInfo, type SessionTurnInfo, SESSIONS_QUERY_SQLITE, buildFilesQuery, buildRefsQuery, buildStandupPrompt, buildTurnsQuery } from '../../chronicle/common/standupPrompt';
import { CloudSessionStoreClient } from '../../chronicle/node/cloudSessionStoreClient';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext, IIntentSlashCommandInfo, NullIntentInvocation } from '../../prompt/node/intents';

/** DuckDB-dialect sessions query (cloud uses DuckDB, not SQLite). */
const SESSIONS_QUERY_DUCKDB = `SELECT id, summary, branch, repository, cwd, created_at, updated_at
	FROM sessions
	WHERE updated_at >= now() - INTERVAL '7 day'
	ORDER BY updated_at DESC`;

/** DuckDB-dialect refs query. */
function buildRefsQueryDuckDB(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, ref_type, ref_value FROM session_refs WHERE session_id IN (${ids})`;
}

/** DuckDB-dialect files query. */
function buildFilesQueryDuckDB(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, file_path, tool_name FROM session_files WHERE session_id IN (${ids})`;
}

/** DuckDB-dialect turns query. */
function buildTurnsQueryDuckDB(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, turn_index, left(user_message, 120) as user_message, left(assistant_response, 200) as assistant_response FROM turns WHERE session_id IN (${ids}) AND (user_message IS NOT NULL OR assistant_response IS NOT NULL) ORDER BY session_id, turn_index`;
}

const SUBCOMMANDS = ['standup', 'tips', 'improve'] as const;
type ChronicleSubcommand = typeof SUBCOMMANDS[number];

export class ChronicleIntent implements IIntent {

	static readonly ID = 'chronicle';
	readonly id = ChronicleIntent.ID;
	readonly locations = [ChatLocation.Panel];
	readonly description = l10n.t('Session history tools and insights (standup, tips, improve)');

	readonly commandInfo: IIntentSlashCommandInfo = {
		allowsEmptyArgs: true,
	};

	constructor(
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ISessionStore private readonly sessionStore: ISessionStore,
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
	) { }

	async handleRequest(
		_conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken,
		_documentContext: IDocumentContext | undefined,
		_agentName: string,
		_location: ChatLocation,
		_chatTelemetry: ChatTelemetryBuilder,
	): Promise<vscode.ChatResult> {
		const { subcommand, rest } = this._parseSubcommand(request.prompt);

		switch (subcommand) {
			case 'standup':
				return this._handleStandup(rest, stream, request, token);
			case 'tips':
			case 'improve':
				stream.markdown(l10n.t('`/chronicle {0}` is not yet implemented. Try `/chronicle standup`.', subcommand));
				return {};
			default: {
				stream.markdown(l10n.t(
					'Unknown subcommand `{0}`. Available subcommands: {1}',
					subcommand,
					SUBCOMMANDS.join(', '),
				));
				return {};
			}
		}
	}

	private _parseSubcommand(prompt: string | undefined): { subcommand: ChronicleSubcommand | string; rest: string | undefined } {
		const trimmed = prompt?.trim() ?? '';
		if (!trimmed) {
			return { subcommand: 'standup', rest: undefined };
		}
		const spaceIdx = trimmed.indexOf(' ');
		if (spaceIdx === -1) {
			return { subcommand: trimmed.toLowerCase(), rest: undefined };
		}
		return {
			subcommand: trimmed.slice(0, spaceIdx).toLowerCase(),
			rest: trimmed.slice(spaceIdx + 1).trim() || undefined,
		};
	}

	private async _handleStandup(
		extra: string | undefined,
		stream: vscode.ChatResponseStream,
		request: vscode.ChatRequest,
		token: CancellationToken,
	): Promise<vscode.ChatResult> {
		// Query VS Code's local session store
		const vscodeSessions = this._queryStore(this.sessionStore, 'vscode');

		// Query CLI's session store if it exists (~/.copilot/session-store.db)
		const cliSessions = this._queryCliStore();

		// Query cloud session store (cross-machine sessions)
		const cloudSessions = await this._queryCloudStore();

		// Skip dedup for now — always include cloud sessions to validate cloud is working
		console.log(`[Chronicle] Cloud: ${cloudSessions.sessions.length} sessions (dedup disabled for demo)`);

		// Cap each source to top 20 most recent to keep prompt manageable
		const MAX_SESSIONS_PER_SOURCE = 20;
		const cappedVscode = this._capResults(vscodeSessions, MAX_SESSIONS_PER_SOURCE);
		const cappedCli = this._capResults(cliSessions, MAX_SESSIONS_PER_SOURCE);
		const cappedCloud = this._capResults(cloudSessions, MAX_SESSIONS_PER_SOURCE);

		const sessions: AnnotatedSession[] = [...cappedVscode.sessions, ...cappedCli.sessions, ...cappedCloud.sessions];
		const refs: AnnotatedRef[] = [...cappedVscode.refs, ...cappedCli.refs, ...cappedCloud.refs];
		const files: SessionFileInfo[] = [...cappedVscode.files, ...cappedCli.files, ...cappedCloud.files];
		const turns: SessionTurnInfo[] = [...cappedVscode.turns, ...cappedCli.turns, ...cappedCloud.turns];

		// Sort merged results by updated_at descending
		sessions.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

		const standupPrompt = buildStandupPrompt(sessions, refs, extra, files, turns);
		console.log(`[Chronicle] Prompt size: ${standupPrompt.length} chars, cloud sessions in prompt: ${sessions.filter(s => s.source === 'cloud').length}`);

		if (sessions.length === 0) {
			stream.markdown(l10n.t('No sessions found in the last 24 hours. There\'s nothing to report for a standup.'));
			return {};
		}

		const vscodeCount = vscodeSessions.sessions.length;
		const cliCount = cliSessions.sessions.length;
		const cloudCount = cloudSessions.sessions.length;
		const parts = [`${vscodeCount} VS Code`, `${cliCount} CLI`];
		if (cloudCount > 0) {
			parts.push(`${cloudCount} cloud`);
		}
		stream.progress(l10n.t('Generating standup from {0} session(s) ({1})...', sessions.length, parts.join(', ')));

		const model = request.model;
		const messages = [
			LanguageModelChatMessage.User(standupPrompt),
		];

		const response = await model.sendRequest(messages, {}, token);

		for await (const part of response.text) {
			stream.markdown(part);
		}

		return {};
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
			console.log('[Chronicle] CLI DB not found at', cliDbPath);
			return { sessions: [], refs: [], files: [], turns: [] };
		}

		let cliStore: SessionStore | undefined;
		try {
			console.log('[Chronicle] Opening CLI DB at', cliDbPath);
			cliStore = new SessionStore(cliDbPath);
			const result = this._queryStore(cliStore, 'cli');
			console.log(`[Chronicle] CLI DB returned ${result.sessions.length} sessions, ${result.refs.length} refs, ${result.files.length} files, ${result.turns.length} turns`);
			return result;
		} catch (err) {
			console.error('[Chronicle] Error querying CLI DB:', err);
			return { sessions: [], refs: [], files: [], turns: [] };
		} finally {
			cliStore?.close();
		}
	}

	private async _queryCloudStore(): Promise<{ sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] }> {
		const empty = { sessions: [] as AnnotatedSession[], refs: [] as AnnotatedRef[], files: [] as SessionFileInfo[], turns: [] as SessionTurnInfo[] };
		try {
			const client = new CloudSessionStoreClient(this._tokenManager, this._authService);

			// Query sessions
			const sessionsResult = await client.executeQuery(SESSIONS_QUERY_DUCKDB);
			if (!sessionsResult || sessionsResult.rows.length === 0) {
				console.log('[Chronicle] Cloud returned no sessions');
				return empty;
			}

			const sessions: AnnotatedSession[] = sessionsResult.rows.map(r => ({
				id: r.id as string,
				summary: r.summary as string | undefined,
				branch: r.branch as string | undefined,
				repository: r.repository as string | undefined,
				cwd: r.cwd as string | undefined,
				created_at: r.created_at as string | undefined,
				updated_at: r.updated_at as string | undefined,
				source: 'cloud' as const,
			}));

			const ids = sessions.map(s => s.id);

			// Query refs, files, turns in parallel
			const [refsResult, filesResult, turnsResult] = await Promise.all([
				client.executeQuery(buildRefsQueryDuckDB(ids)),
				client.executeQuery(buildFilesQueryDuckDB(ids)),
				client.executeQuery(buildTurnsQueryDuckDB(ids)),
			]);

			const refs: AnnotatedRef[] = (refsResult?.rows ?? []).map(r => ({
				session_id: r.session_id as string,
				ref_type: r.ref_type as 'commit' | 'pr' | 'issue',
				ref_value: r.ref_value as string,
				source: 'cloud' as const,
			}));

			const files: SessionFileInfo[] = (filesResult?.rows ?? []).map(r => ({
				session_id: r.session_id as string,
				file_path: r.file_path as string,
				tool_name: r.tool_name as string | undefined,
			}));

			const turns: SessionTurnInfo[] = (turnsResult?.rows ?? []).map(r => ({
				session_id: r.session_id as string,
				turn_index: r.turn_index as number,
				user_message: r.user_message as string,
				assistant_response: r.assistant_response as string | undefined,
			}));

			console.log(`[Chronicle] Cloud returned ${sessions.length} sessions, ${refs.length} refs, ${files.length} files, ${turns.length} turns`);
			return { sessions, refs, files, turns };
		} catch (err) {
			console.error('[Chronicle] Cloud query failed:', err);
			return empty;
		}
	}

	/**
	 * Cap query results to the N most recent sessions, keeping only related refs/files/turns.
	 */
	private _capResults(
		results: { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] },
		max: number,
	): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		if (results.sessions.length <= max) {
			return results;
		}
		const kept = results.sessions.slice(0, max);
		const keptIds = new Set(kept.map(s => s.id));
		return {
			sessions: kept,
			refs: results.refs.filter(r => keptIds.has(r.session_id)),
			files: results.files.filter(f => keptIds.has(f.session_id)),
			turns: results.turns.filter(t => keptIds.has(t.session_id)),
		};
	}

	async invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		const { location, request } = invocationContext;
		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		return new NullIntentInvocation(this, location, endpoint);
	}
}
