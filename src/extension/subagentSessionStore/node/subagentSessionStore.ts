/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { LRUCache } from '../../../util/vs/base/common/map';
import { LanguageModelToolResult2 } from '../../../vscodeTypes';
import { IToolCallRound } from '../../prompt/common/intents';

/**
 * Represents a saved subagent session that can be resumed.
 * Contains the full conversation transcript (tool call rounds + results)
 * needed to restore context on resume.
 */
export interface ISubagentSession {
	/** The stable subAgentInvocationId for this session. */
	readonly subAgentInvocationId: string;
	/** Optional agent name for this session. */
	readonly subAgentName?: string;
	/** The original prompt that started this session. */
	readonly originalPrompt: string;
	/** The tool call rounds from the subagent's conversation. */
	readonly toolCallRounds: IToolCallRound[];
	/** The tool call results keyed by tool call ID. */
	readonly toolCallResults: Record<string, LanguageModelToolResult2>;
	/** The final response text from the last run. */
	readonly lastResponse: string;
	/** Timestamp of when the session was saved. */
	readonly savedAt: number;
}

export const ISubagentSessionStore = createServiceIdentifier<ISubagentSessionStore>('ISubagentSessionStore');

export interface ISubagentSessionStore {
	readonly _serviceBrand: undefined;

	/**
	 * Save a subagent session for potential resume later.
	 */
	saveSession(session: ISubagentSession): void;

	/**
	 * Retrieve a saved subagent session by its invocation ID.
	 * Returns undefined if no session exists for this ID.
	 */
	getSession(subAgentInvocationId: string): ISubagentSession | undefined;

	/**
	 * Check if a session exists for the given invocation ID.
	 */
	hasSession(subAgentInvocationId: string): boolean;

	/**
	 * Remove a session by its invocation ID.
	 */
	removeSession(subAgentInvocationId: string): void;
}

/**
 * Maximum number of subagent sessions to keep in the LRU cache.
 * Older sessions are evicted when this limit is reached.
 */
const MAX_SESSIONS = 100;

export class SubagentSessionStore implements ISubagentSessionStore {
	readonly _serviceBrand: undefined;

	private readonly sessions: LRUCache<string, ISubagentSession>;

	constructor() {
		this.sessions = new LRUCache<string, ISubagentSession>(MAX_SESSIONS);
	}

	saveSession(session: ISubagentSession): void {
		this.sessions.set(session.subAgentInvocationId, session);
	}

	getSession(subAgentInvocationId: string): ISubagentSession | undefined {
		return this.sessions.get(subAgentInvocationId);
	}

	hasSession(subAgentInvocationId: string): boolean {
		return this.sessions.has(subAgentInvocationId);
	}

	removeSession(subAgentInvocationId: string): void {
		this.sessions.delete(subAgentInvocationId);
	}
}
