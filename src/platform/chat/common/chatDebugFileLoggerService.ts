/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { URI } from '../../../util/vs/base/common/uri';

export const IChatDebugFileLoggerService = createServiceIdentifier<IChatDebugFileLoggerService>('IChatDebugFileLoggerService');

/**
 * Service that writes chat debug events (OTel spans + discovery events) to
 * per-session JSONL files on disk. These files can be read by skills,
 * subagents, etc via `read_file` tool to diagnose chat issues.
 */
export interface IChatDebugFileLoggerService {
	readonly _serviceBrand: undefined;

	/**
	 * Begin logging for a session. Registers the session in memory;
	 * directory creation and file writes are deferred to the first flush.
	 */
	startSession(sessionId: string): Promise<void>;

	/**
	 * End logging for a session. Performs a final flush and removes the
	 * session from the active set.
	 */
	endSession(sessionId: string): Promise<void>;

	/**
	 * Flush any buffered entries to disk for the given session.
	 */
	flush(sessionId: string): Promise<void>;

	/**
	 * Get the URI of the debug log file for a session, or undefined if the
	 * session has not been started.
	 */
	getLogPath(sessionId: string): URI | undefined;

	/**
	 * Returns the session IDs of all currently active logging sessions.
	 */
	getActiveSessionIds(): string[];

	/**
	 * Check whether a URI is under the debug-logs storage directory.
	 * Used by {@link assertFileOkForTool} to allowlist tool reads.
	 */
	isDebugLogUri(uri: URI): boolean;
}

/**
 * No-op implementation for testing and environments without workspace storage.
 */
export class NullChatDebugFileLoggerService implements IChatDebugFileLoggerService {
	declare readonly _serviceBrand: undefined;

	async startSession(): Promise<void> { }
	async endSession(): Promise<void> { }
	async flush(): Promise<void> { }
	getLogPath(): URI | undefined { return undefined; }
	getActiveSessionIds(): string[] { return []; }
	isDebugLogUri(): boolean { return false; }
}
