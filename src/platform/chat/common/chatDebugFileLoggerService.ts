/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { decodeBase64 } from '../../../util/vs/base/common/buffer';
import { URI } from '../../../util/vs/base/common/uri';

export const IChatDebugFileLoggerService = createServiceIdentifier<IChatDebugFileLoggerService>('IChatDebugFileLoggerService');

/**
 * Extract the chat session ID string from a session resource URI.
 *
 * - `vscode-chat-session://local/<base64EncodedSessionId>` — decodes base64
 * - `copilotcli:///<sessionId>` and `claude-code:///<sessionId>` — uses raw path segment
 */
export function sessionResourceToId(sessionResource: URI): string {
	const pathSegment = sessionResource.path.replace(/^\//, '').split('/').pop() || '';
	if (!pathSegment) {
		return pathSegment;
	}
	// Only vscode-chat-session URIs use base64-encoded session IDs
	if (sessionResource.scheme === 'vscode-chat-session') {
		try {
			return new TextDecoder().decode(decodeBase64(pathSegment).buffer);
		} catch {
			// Not valid base64 — fall through to raw segment
		}
	}
	return pathSegment;
}

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
	 * Get the URI of the debug logs directory, or undefined if it cannot be
	 * determined (e.g. no workspace, or an error occurs). The directory may
	 * not actually exist on disk yet if no sessions have been started.
	 */
	readonly debugLogsDir: URI | undefined;

	/**
	 * Get the URI of the debug log file for a session, or undefined if the
	 * session has not been started.
	 */
	getLogPath(sessionId: string): URI | undefined;

	/**
	 * Get the session directory URI for a session. For both parent and child
	 * sessions this returns the parent session's directory
	 * (e.g. `debug-logs/<parentSessionId>/`).
	 */
	getSessionDir(sessionId: string): URI | undefined;

	/**
	 * Returns the session IDs of all currently active logging sessions.
	 */
	getActiveSessionIds(): string[];

	/**
	 * Check whether a URI is under the debug-logs storage directory.
	 * Used by {@link assertFileOkForTool} to allowlist tool reads.
	 */
	isDebugLogUri(uri: URI): boolean;

	/**
	 * Convenience method: decode a session resource URI and return the
	 * session directory, or `undefined` if the session is unknown.
	 */
	getSessionDirForResource(sessionResource: URI): URI | undefined;

	/**
	 * Cache the latest model list snapshot from the API. The data is written
	 * as `models.json` into each session directory when a session starts.
	 */
	setModelSnapshot(models: readonly unknown[]): void;
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
	getSessionDir(): URI | undefined { return undefined; }
	getActiveSessionIds(): string[] { return []; }
	isDebugLogUri(): boolean { return false; }
	getSessionDirForResource(): URI | undefined { return undefined; }
	setModelSnapshot(): void { }
	readonly debugLogsDir: URI | undefined = undefined;
}
