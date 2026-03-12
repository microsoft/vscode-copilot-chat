/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { IChatDebugFileLoggerService } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../platform/otel/common/index';
import { ICompletedSpanData, IOTelService, ISpanEventData, SpanStatusCode } from '../../../platform/otel/common/otelService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IExtensionContribution } from '../../common/contributions';

const DEBUG_LOGS_DIR_NAME = 'debug-logs';
const MAX_RETAINED_LOGS = 50;
const AUTO_FLUSH_INTERVAL_MS = 2_000;
const MAX_ATTR_VALUE_LENGTH = 500;
const MAX_PENDING_CORE_EVENTS = 100;

interface IActiveLogSession {
	readonly uri: URI;
	/** The directory containing this session's log files */
	readonly sessionDir: URI;
	readonly buffer: string[];
	flushPromise: Promise<void>;
	dirEnsured: boolean;
	bytesWritten: number;
	/** Parent session ID if this is a child session (e.g., title, categorization) */
	readonly parentSessionId?: string;
	/** Label for child sessions (e.g., 'title', 'categorization') */
	readonly label?: string;
	/** Whether this session has received its own OTel spans (vs being auto-created as a parent ref) */
	hasOwnSpans: boolean;
}

/**
 * A single JSONL debug log entry.
 */
interface IDebugLogEntry {
	/** Epoch ms timestamp */
	readonly ts: number;
	/** Duration in ms (0 for instant events) */
	readonly dur: number;
	/** Chat session ID */
	readonly sid: string;
	/** Event type */
	readonly type: 'tool_call' | 'llm_request' | 'user_message' | 'agent_response' | 'subagent' | 'discovery' | 'error' | 'generic' | 'child_session_ref';
	/** Descriptive name */
	readonly name: string;
	/** Span or event ID */
	readonly spanId: string;
	/** Parent span ID for hierarchy */
	readonly parentSpanId?: string;
	/** Status */
	readonly status: 'ok' | 'error';
	/** Type-specific attributes */
	readonly attrs: Record<string, string | number | boolean | undefined>;
}

export class ChatDebugFileLoggerService extends Disposable implements IChatDebugFileLoggerService {
	declare readonly _serviceBrand: undefined;

	public readonly id = 'chatDebugFileLogger';

	private readonly _activeSessions = new Map<string, IActiveLogSession>();
	/** Maps child session ID → { parentSessionId, label } for child session routing */
	private readonly _childSessionMap = new Map<string, { parentSessionId: string; label: string }>();
	private readonly _pendingCoreEvents: IDebugLogEntry[] = [];
	private _debugLogsDirUri: URI | undefined;
	private _autoFlushTimer: ReturnType<typeof setInterval> | undefined;
	private _totalBytesWritten = 0;
	private _totalSessionCount = 0;

	constructor(
		@IOTelService private readonly _otelService: IOTelService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		const enabled = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.ChatDebugFileLogging, this._experimentationService);
		if (!enabled) {
			this._telemetryService.sendTelemetryEvent('chatDebugFileLogger.disabled', { github: false, microsoft: true });
			return;
		}

		// Subscribe to OTel span completions
		this._register(this._otelService.onDidCompleteSpan(span => {
			this._onSpanCompleted(span);
		}));

		// Subscribe to OTel span events (real-time user messages)
		this._register(this._otelService.onDidEmitSpanEvent(event => {
			this._onSpanEvent(event);
		}));

		// Subscribe to core debug events (discovery, skill loading, etc.)
		if (typeof vscode.chat?.onDidReceiveChatDebugEvent === 'function') {
			this._register(vscode.chat.onDidReceiveChatDebugEvent(event => {
				this._onCoreDebugEvent(event);
			}));
		}
	}

	override dispose(): void {
		if (this._autoFlushTimer) {
			clearInterval(this._autoFlushTimer);
			this._autoFlushTimer = undefined;
		}
		// Accumulate any remaining active session bytes before emitting telemetry
		for (const session of this._activeSessions.values()) {
			this._totalBytesWritten += session.bytesWritten;
		}
		this._telemetryService.sendTelemetryEvent('chatDebugFileLogger.end', { github: false, microsoft: true }, undefined, { totalBytesWritten: this._totalBytesWritten, sessionCount: this._totalSessionCount });
		super.dispose();
	}

	private _getDebugLogsDir(): URI | undefined {
		if (this._debugLogsDirUri) {
			return this._debugLogsDirUri;
		}
		const storageUri = this._extensionContext.storageUri as URI | undefined;
		if (!storageUri) {
			return undefined;
		}
		this._debugLogsDirUri = URI.joinPath(storageUri, DEBUG_LOGS_DIR_NAME);
		return this._debugLogsDirUri;
	}

	async startSession(sessionId: string): Promise<void> {
		this._ensureSession(sessionId, /* hasOwnSpans */ true);
	}

	/**
	 * Synchronously ensure a session exists for buffering. Directory creation
	 * and old-log cleanup are deferred to the first flush.
	 *
	 * Sessions are organized in directories:
	 * - Parent session: `debug-logs/<sessionId>/main.jsonl`
	 * - Child session: `debug-logs/<parentSessionId>/<label>-<childSessionId>.jsonl`
	 */
	private _ensureSession(sessionId: string, hasOwnSpans = false): void {
		const existing = this._activeSessions.get(sessionId);
		if (existing) {
			// Mark that this session now has its own spans (upgrades from auto-created parent ref)
			if (hasOwnSpans && !existing.hasOwnSpans) {
				existing.hasOwnSpans = true;
				// Now that we know this is a real session, replay pending core events
				if (!existing.parentSessionId) {
					for (const entry of this._pendingCoreEvents) {
						this._bufferEntry(sessionId, { ...entry, sid: sessionId });
					}
				}
			}
			return;
		}

		this._totalSessionCount++;

		const dir = this._getDebugLogsDir();
		if (!dir) {
			return;
		}

		const childInfo = this._childSessionMap.get(sessionId);
		let sessionDir: URI;
		let fileUri: URI;

		if (childInfo) {
			// Child session — write under parent's directory
			sessionDir = URI.joinPath(dir, childInfo.parentSessionId);
			const fileName = `${childInfo.label}-${sessionId}.jsonl`;
			fileUri = URI.joinPath(sessionDir, fileName);

			// Ensure parent session exists so we can write a cross-reference
			this._ensureSession(childInfo.parentSessionId);

			// Write a cross-reference entry in the parent's main.jsonl
			this._bufferEntry(childInfo.parentSessionId, {
				ts: Date.now(),
				dur: 0,
				sid: childInfo.parentSessionId,
				type: 'child_session_ref',
				name: childInfo.label,
				spanId: `child-ref-${sessionId}`,
				status: 'ok',
				attrs: {
					childSessionId: sessionId,
					childLogFile: `${childInfo.label}-${sessionId}.jsonl`,
					label: childInfo.label,
				},
			});
		} else {
			// Parent session — write as main.jsonl in its own directory
			sessionDir = URI.joinPath(dir, sessionId);
			fileUri = URI.joinPath(sessionDir, 'main.jsonl');
		}

		const session: IActiveLogSession = {
			uri: fileUri,
			sessionDir,
			buffer: [],
			flushPromise: Promise.resolve(),
			dirEnsured: false,
			bytesWritten: 0,
			parentSessionId: childInfo?.parentSessionId,
			label: childInfo?.label,
			hasOwnSpans,
		};
		this._activeSessions.set(sessionId, session);

		// Replay pending core events only for parent sessions that have their own spans
		// (not for sessions auto-created as a side effect of child parent references)
		if (!childInfo && hasOwnSpans) {
			for (const entry of this._pendingCoreEvents) {
				this._bufferEntry(sessionId, { ...entry, sid: sessionId });
			}
		}

		// Start auto-flush timer if this is the first active session
		if (this._activeSessions.size === 1 && !this._autoFlushTimer) {
			this._autoFlushTimer = setInterval(() => this._autoFlushAll(), AUTO_FLUSH_INTERVAL_MS);
		}

		// Fire-and-forget cleanup of old logs
		this._cleanupOldLogs().catch(() => { });
	}

	async endSession(sessionId: string): Promise<void> {
		await this.flush(sessionId);
		const session = this._activeSessions.get(sessionId);
		if (session) {
			this._totalBytesWritten += session.bytesWritten;
		}
		this._activeSessions.delete(sessionId);

		// Stop auto-flush timer if no active sessions remain
		if (this._activeSessions.size === 0 && this._autoFlushTimer) {
			clearInterval(this._autoFlushTimer);
			this._autoFlushTimer = undefined;
		}
	}

	async flush(sessionId: string): Promise<void> {
		const session = this._activeSessions.get(sessionId);
		if (!session || session.buffer.length === 0) {
			return;
		}

		// Skip flushing for parent sessions that were auto-created as parent
		// references by child sessions (e.g., subagent VS Code sessions).
		// These have no meaningful content of their own.
		if (!session.parentSessionId && !session.hasOwnSpans) {
			session.buffer.length = 0;
			return;
		}

		const lines = session.buffer.splice(0);
		const content = lines.join('');

		session.flushPromise = session.flushPromise.then(
			() => this._writeToFile(session, content),
			() => this._writeToFile(session, content),
		);
		return session.flushPromise;
	}

	getLogPath(sessionId: string): URI | undefined {
		return this._activeSessions.get(sessionId)?.uri;
	}

	getSessionDir(sessionId: string): URI | undefined {
		return this._activeSessions.get(sessionId)?.sessionDir;
	}

	getActiveSessionIds(): string[] {
		return [...this._activeSessions.keys()];
	}

	isDebugLogUri(uri: URI): boolean {
		const dir = this._getDebugLogsDir();
		if (!dir) {
			return false;
		}
		return extUriBiasedIgnorePathCase.isEqualOrParent(uri, dir);
	}

	// ── OTel span handling ──

	private _onSpanCompleted(span: ICompletedSpanData): void {
		const sessionId = this._extractSessionId(span);
		if (!sessionId) {
			return;
		}

		// Check if this span carries parent session info (e.g., title, categorization)
		const parentChatSessionId = asString(span.attributes[CopilotChatAttr.PARENT_CHAT_SESSION_ID]);
		const debugLogLabel = asString(span.attributes[CopilotChatAttr.DEBUG_LOG_LABEL]);
		if (parentChatSessionId && debugLogLabel && !this._childSessionMap.has(sessionId)) {
			this._childSessionMap.set(sessionId, { parentSessionId: parentChatSessionId, label: debugLogLabel });
		}

		// Auto-start session on first span seen for this session ID
		this._ensureSession(sessionId, /* hasOwnSpans */ true);

		const entry = this._spanToEntry(span, sessionId);
		if (entry) {
			this._bufferEntry(sessionId, entry);
		}

		// Note: user_message events are captured in real-time via _onSpanEvent
		// (onDidEmitSpanEvent) to avoid duplicates, since span.events also
		// contains them after completion.

		// Extract agent_response from output messages (on chat spans)
		const opName = asString(span.attributes[GenAiAttr.OPERATION_NAME]);
		if (opName === GenAiOperationName.CHAT) {
			// Extract agent response summary from output messages
			const outputMessages = asString(span.attributes[GenAiAttr.OUTPUT_MESSAGES]);
			if (outputMessages) {
				this._bufferEntry(sessionId, {
					ts: span.endTime,
					dur: 0,
					sid: sessionId,
					type: 'agent_response',
					name: 'agent_response',
					spanId: `agent-msg-${span.spanId}`,
					parentSpanId: span.parentSpanId,
					status: 'ok',
					attrs: {
						response: truncate(outputMessages, MAX_ATTR_VALUE_LENGTH),
					},
				});
			}
		}
	}

	private _onSpanEvent(event: ISpanEventData): void {
		if (event.eventName !== 'user_message') {
			return;
		}
		const content = event.attributes.content;
		if (!content || (typeof content === 'string' && !content.trim())) {
			return;
		}

		// Span events don't carry chat_session_id — write to parent sessions that have their own spans
		const parentSessions = [...this._activeSessions.entries()]
			.filter(([, session]) => !session.parentSessionId && session.hasOwnSpans)
			.map(([id]) => id);
		if (parentSessions.length === 0) {
			return;
		}

		for (const sessionId of parentSessions) {
			const entry: IDebugLogEntry = {
				ts: event.timestamp,
				dur: 0,
				sid: sessionId,
				type: 'user_message',
				name: 'user_message',
				spanId: event.spanId,
				parentSpanId: event.parentSpanId,
				status: 'ok',
				attrs: {
					content: truncate(String(content), MAX_ATTR_VALUE_LENGTH),
				},
			};
			this._bufferEntry(sessionId, entry);
		}
	}

	// ── Core debug event handling (discovery, skill loading, etc.) ──

	private _onCoreDebugEvent(event: vscode.ChatDebugEvent): void {
		// Only capture discovery/generic events from core — tool calls, model turns,
		// and subagent invocations come from OTel spans which are the source of truth.
		if (!(event instanceof vscode.ChatDebugGenericEvent)) {
			return;
		}

		const timestamp = event.created.getTime();
		const eventId = event.id;
		const parentEventId = event.parentEventId;

		const entry: IDebugLogEntry = {
			ts: timestamp,
			dur: 0,
			sid: '',
			type: event.category === 'discovery' ? 'discovery' : 'generic',
			name: event.name,
			spanId: eventId ?? `core-${Date.now()}`,
			parentSpanId: parentEventId,
			status: event.level === vscode.ChatDebugLogLevel.Error ? 'error' : 'ok',
			attrs: {
				...(event.details ? { details: truncate(event.details, MAX_ATTR_VALUE_LENGTH) } : {}),
				...(event.category ? { category: event.category } : {}),
				source: 'core',
			},
		};

		// Core events may arrive before any session exists — cache and replay.
		// Cap the buffer to avoid unbounded growth over long-running sessions.
		if (this._pendingCoreEvents.length >= MAX_PENDING_CORE_EVENTS) {
			this._pendingCoreEvents.shift();
		}
		this._pendingCoreEvents.push(entry);
		// Only write to parent sessions that have their own spans
		for (const [sessionId, session] of this._activeSessions.entries()) {
			if (!session.parentSessionId && session.hasOwnSpans) {
				this._bufferEntry(sessionId, { ...entry, sid: sessionId });
			}
		}
	}

	// ── Span to entry conversion ──

	private _spanToEntry(span: ICompletedSpanData, sessionId: string): IDebugLogEntry | undefined {
		const opName = asString(span.attributes[GenAiAttr.OPERATION_NAME]);
		const duration = span.endTime - span.startTime;
		const isError = span.status.code === SpanStatusCode.ERROR;

		switch (opName) {
			case GenAiOperationName.EXECUTE_TOOL: {
				const toolName = asString(span.attributes[GenAiAttr.TOOL_NAME]) ?? span.name;
				return {
					ts: span.startTime,
					dur: duration,
					sid: sessionId,
					type: 'tool_call',
					name: toolName,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					status: isError ? 'error' : 'ok',
					attrs: {
						...(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS] !== undefined
							? { args: truncate(String(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]), MAX_ATTR_VALUE_LENGTH) }
							: {}),
						...(span.attributes[GenAiAttr.TOOL_CALL_RESULT] !== undefined
							? { result: truncate(String(span.attributes[GenAiAttr.TOOL_CALL_RESULT]), MAX_ATTR_VALUE_LENGTH) }
							: {}),
						...(isError && span.status.message ? { error: span.status.message } : {}),
					},
				};
			}

			case GenAiOperationName.CHAT: {
				const model = asString(span.attributes[GenAiAttr.REQUEST_MODEL])
					?? asString(span.attributes[GenAiAttr.RESPONSE_MODEL])
					?? 'unknown';
				return {
					ts: span.startTime,
					dur: duration,
					sid: sessionId,
					type: 'llm_request',
					name: `chat:${model}`,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					status: isError ? 'error' : 'ok',
					attrs: {
						model,
						...(span.attributes[GenAiAttr.USAGE_INPUT_TOKENS] !== undefined
							? { inputTokens: asNumber(span.attributes[GenAiAttr.USAGE_INPUT_TOKENS]) }
							: {}),
						...(span.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS] !== undefined
							? { outputTokens: asNumber(span.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]) }
							: {}),
						...(span.attributes[CopilotChatAttr.TIME_TO_FIRST_TOKEN] !== undefined
							? { ttft: asNumber(span.attributes[CopilotChatAttr.TIME_TO_FIRST_TOKEN]) }
							: {}),
						...(isError && span.status.message ? { error: span.status.message } : {}),
					},
				};
			}

			case GenAiOperationName.INVOKE_AGENT: {
				if (!span.parentSpanId) {
					return undefined; // Top-level agent spans are containers
				}
				const agentName = asString(span.attributes[GenAiAttr.AGENT_NAME]) ?? span.name;
				return {
					ts: span.startTime,
					dur: duration,
					sid: sessionId,
					type: 'subagent',
					name: agentName,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					status: isError ? 'error' : 'ok',
					attrs: {
						agentName,
						...(span.attributes[GenAiAttr.AGENT_DESCRIPTION] !== undefined
							? { description: truncate(String(span.attributes[GenAiAttr.AGENT_DESCRIPTION]), MAX_ATTR_VALUE_LENGTH) }
							: {}),
						...(isError && span.status.message ? { error: span.status.message } : {}),
					},
				};
			}

			case GenAiOperationName.CONTENT_EVENT:
			case 'core_event': {
				const name = asString(span.attributes[CopilotChatAttr.DEBUG_NAME]) ?? span.name;
				return {
					ts: span.startTime,
					dur: duration,
					sid: sessionId,
					type: 'generic',
					name,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					status: isError ? 'error' : 'ok',
					attrs: {
						...(span.attributes['copilot_chat.event_details'] !== undefined
							? { details: truncate(String(span.attributes['copilot_chat.event_details']), MAX_ATTR_VALUE_LENGTH) }
							: {}),
						...(span.attributes['copilot_chat.event_category'] !== undefined
							? { category: String(span.attributes['copilot_chat.event_category']) }
							: {}),
					},
				};
			}

			default:
				return undefined;
		}
	}

	// ── Helpers ──

	private _extractSessionId(span: ICompletedSpanData): string | undefined {
		return asString(span.attributes[CopilotChatAttr.CHAT_SESSION_ID])
			?? asString(span.attributes[GenAiAttr.CONVERSATION_ID]);
	}

	private _bufferEntry(sessionId: string, entry: IDebugLogEntry): void {
		const session = this._activeSessions.get(sessionId);
		if (!session) {
			return;
		}
		session.buffer.push(JSON.stringify(entry) + '\n');
	}

	private async _writeToFile(session: IActiveLogSession, content: string): Promise<void> {
		try {
			if (!session.dirEnsured) {
				await createDirectoryIfNotExists(this._fileSystemService, session.sessionDir);
				session.dirEnsured = true;
			}
			await fs.promises.appendFile(session.uri.fsPath, content, 'utf-8');
			session.bytesWritten += Buffer.byteLength(content, 'utf-8');
		} catch (err) {
			this._logService.error('[ChatDebugFileLogger] Failed to write debug log entries', err);
		}
	}

	private _autoFlushAll(): void {
		for (const sessionId of this._activeSessions.keys()) {
			this.flush(sessionId).catch(() => { });
		}
	}

	private async _cleanupOldLogs(): Promise<void> {
		const dir = this._getDebugLogsDir();
		if (!dir) {
			return;
		}

		try {
			const entries = await this._fileSystemService.readDirectory(dir);
			// Count both directories (new format) and legacy .jsonl files (old format)
			const sessionEntries = entries.filter(([name, type]) =>
				(type === 2 /* FileType.Directory */) ||
				(name.endsWith('.jsonl') && type === 1 /* FileType.File */)
			);

			if (sessionEntries.length <= MAX_RETAINED_LOGS) {
				return;
			}

			const entryStats = await Promise.all(
				sessionEntries.map(async ([name, type]) => {
					const entryUri = URI.joinPath(dir, name);
					const sessionIdFromEntry = name.replace('.jsonl', '');
					try {
						const stat = await this._fileSystemService.stat(entryUri);
						return { name, uri: entryUri, mtime: stat.mtime, sessionId: sessionIdFromEntry, isDir: type === 2 };
					} catch {
						return { name, uri: entryUri, mtime: 0, sessionId: sessionIdFromEntry, isDir: type === 2 };
					}
				}),
			);

			entryStats.sort((a, b) => a.mtime - b.mtime);

			const toDelete = entryStats.length - MAX_RETAINED_LOGS;
			let deleted = 0;
			for (const entry of entryStats) {
				if (deleted >= toDelete) {
					break;
				}
				if (this._activeSessions.has(entry.sessionId)) {
					continue;
				}
				try {
					await this._fileSystemService.delete(entry.uri, { recursive: true });
					deleted++;
				} catch {
					this._logService.warn(`[ChatDebugFileLogger] Failed to delete old debug log: ${entry.name}`);
				}
			}
		} catch {
			// Directory may not exist yet
		}
	}
}

/**
 * Contribution that eagerly instantiates the ChatDebugFileLoggerService
 * so it starts listening to OTel events at activation time.
 */
export class ChatDebugFileLoggerContribution implements IExtensionContribution {
	public readonly id = 'chatDebugFileLoggerContribution';

	constructor(
		@IChatDebugFileLoggerService _service: IChatDebugFileLoggerService,
	) {
		// The DI resolution of IChatDebugFileLoggerService triggers
		// construction of the singleton, which subscribes to events.
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === 'number' ? v : undefined;
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen) + '[truncated]' : s;
}
