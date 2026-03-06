/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GetSessionMessagesOptions, ListSessionsOptions, Options, Query, SDKSessionInfo, SDKUserMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface IClaudeCodeSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new Claude Code query generator
	 * @param options Query options including prompt and configuration
	 * @returns Query instance for Claude Code responses
	 */
	query(options: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}): Promise<Query>;

	/**
	 * List sessions with metadata.
	 * When `dir` is provided, returns sessions for that project directory.
	 * When omitted, returns sessions across all projects.
	 */
	listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;

	/**
	 * Get messages for a specific session.
	 * @param sessionId UUID of the session to read
	 * @param options Optional dir, limit, and offset
	 * @returns Array of user/assistant messages, or empty array if session not found
	 */
	getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
}

export const IClaudeCodeSdkService = createServiceIdentifier<IClaudeCodeSdkService>('IClaudeCodeSdkService');

/**
 * Service that wraps the Claude Code SDK for DI in tests
 */
export class ClaudeCodeSdkService implements IClaudeCodeSdkService {
	readonly _serviceBrand: undefined;

	public async query(options: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}): Promise<Query> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		return query(options);
	}

	public async listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
		const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
		return listSessions(options);
	}

	public async getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]> {
		const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
		return getSessionMessages(sessionId, options);
	}
}
