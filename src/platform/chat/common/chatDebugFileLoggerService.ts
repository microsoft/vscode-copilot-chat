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
 * The URI is typically `vscode-chat-session://local/<base64EncodedSessionId>`.
 *
 * Decodes the last path segment from base64 if valid, otherwise
 * returns the raw segment as-is.
 */
export function sessionResourceToId(sessionResource: URI): string {
	const pathSegment = sessionResource.path.replace(/^\//, '').split('/').pop() || '';
	if (!pathSegment) {
		return pathSegment;
	}
	try {
		return new TextDecoder().decode(decodeBase64(pathSegment).buffer);
	} catch {
		// Not valid base64 — use raw segment
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
	 * List session directories on disk (not just active sessions).
	 * Returns entries sorted by modification time (most recent first),
	 * capped at {@link maxResults} entries (default 20).
	 */
	listSessionDirsOnDisk(maxResults?: number): Promise<readonly { sessionId: string; mtime: number }[]>;

	/**
	 * Set a pending troubleshoot target. Called by the session picker
	 * before opening a new chat session. The target is consumed by
	 * {@link consumePendingTroubleshootTarget} on the first placeholder
	 * resolution in the new session.
	 */
	setPendingTroubleshootTarget(targetLogDir: URI): void;

	/**
	 * Check whether a pending troubleshoot target exists without consuming it.
	 */
	hasPendingTroubleshootTarget(): boolean;

	/**
	 * Consume and return the pending troubleshoot target, if any.
	 * This is a one-shot operation — the pending target is cleared after consumption.
	 */
	consumePendingTroubleshootTarget(): URI | undefined;

	/**
	 * Register a troubleshoot target for a specific session.
	 * Called after consuming the pending target, so follow-up requests
	 * in the same session continue to resolve to the target.
	 */
	registerTroubleshootTarget(sessionId: string, targetLogDir: URI): void;

	/**
	 * Get the registered troubleshoot target for a session, if any.
	 */
	getTroubleshootTarget(sessionId: string): URI | undefined;
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
	async listSessionDirsOnDisk(): Promise<readonly { sessionId: string; mtime: number }[]> { return []; }
	setPendingTroubleshootTarget(): void { }
	hasPendingTroubleshootTarget(): boolean { return false; }
	consumePendingTroubleshootTarget(): URI | undefined { return undefined; }
	registerTroubleshootTarget(): void { }
	getTroubleshootTarget(): URI | undefined { return undefined; }
	readonly debugLogsDir: URI | undefined = undefined;
}
