/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { GenAiAttr } from '../../../platform/otel/common/index';
import { IOTelService, type ICompletedSpanData, type ISpanEventData } from '../../../platform/otel/common/otelService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import {
	completedSpanToDebugEvent,
	extractConversationEvents,
	extractSessionId,
	resolveAgentResponseFromSpan,
	resolveSpanToContent,
	resolveUserMessageFromSpan,
	spanEventToUserMessage,
} from './otelSpanToChatDebugEvent';
import {
	parseResourceSpans,
	wrapInResourceSpans,
	type ChatDebugLogExport,
} from './otlpFormatConversion';

/**
 * Decode a VS Code chat session resource URI to extract the raw session ID.
 * The URI is typically `vscode-chat-session://local/<base64EncodedSessionId>`.
 */
function decodeSessionId(sessionResource: vscode.Uri): string {
	const pathSegment = sessionResource.path.replace(/^\//, '').split('/').pop() || '';
	if (pathSegment) {
		try {
			return Buffer.from(pathSegment, 'base64').toString('utf-8');
		} catch { /* not base64, use as-is */ }
	}
	return sessionResource.toString();
}

/**
 * OTel-first ChatDebugLogProvider.
 * Single data source: IOTelService spans (via onDidCompleteSpan / onDidEmitSpanEvent).
 *
 * Replaces the previous 3-source architecture (IRequestLogger + ITrajectoryLogger + IAgentDebugEventService).
 */
export class OTelChatDebugLogProviderContribution extends Disposable implements IExtensionContribution {
	public readonly id = 'otelChatDebugLogProvider';

	/** Completed spans bucketed by traceId (all spans in one agent flow share a traceId) */
	private readonly _traceSpans = new Map<string, ICompletedSpanData[]>();

	/** Maps sessionId → Set of traceIds (a session can have multiple traces, one per user message turn) */
	private readonly _sessionTraces = new Map<string, Set<string>>();

	/** Imported sessions (from file import) */
	private readonly _importedSessions = new Map<string, ICompletedSpanData[]>();

	/** Active progress callbacks for streaming events, keyed by decoded session ID */
	private readonly _activeStreams = new Map<string, vscode.Progress<vscode.ChatDebugEvent>>();

	/** Maps decoded VS Code session ID → active progress key (for associating new traces with the session) */
	private readonly _activeSessionIds = new Set<string>();

	constructor(
		@IOTelService private readonly _otelService: IOTelService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Listen for completed spans and bucket by session
		this._register(this._otelService.onDidCompleteSpan(span => {
			this._onSpanCompleted(span);
		}));

		// Listen for span events for real-time user message streaming
		this._register(this._otelService.onDidEmitSpanEvent(event => {
			this._onSpanEvent(event);
		}));

		// Register as the debug log provider
		this._register(vscode.chat.registerChatDebugLogProvider({
			provideChatDebugLog: (sessionResource, progress, token) =>
				this._provideChatDebugLog(sessionResource, progress, token),
			resolveChatDebugLogEvent: (eventId, token) =>
				this._resolveChatDebugLogEvent(eventId, token),
			provideChatDebugLogExport: (sessionResource, token) =>
				this._provideChatDebugLogExport(sessionResource, token),
			resolveChatDebugLogImport: (data, token) =>
				this._resolveChatDebugLogImport(data, token),
		}));
	}

	private _onSpanCompleted(span: ICompletedSpanData): void {
		const traceId = span.traceId;
		if (!traceId) { return; }

		// Bucket by traceId — all spans in one agent flow share a traceId
		let spans = this._traceSpans.get(traceId);
		if (!spans) {
			spans = [];
			this._traceSpans.set(traceId, spans);
		}
		spans.push(span);

		// Map all known session/conversation IDs to this trace
		const sessionId = extractSessionId(span);
		if (sessionId) {
			let traces = this._sessionTraces.get(sessionId);
			if (!traces) {
				traces = new Set();
				this._sessionTraces.set(sessionId, traces);
			}
			traces.add(traceId);
		}
		// Also map gen_ai.conversation.id (may be different from copilot_chat.session_id)
		const conversationId = asString(span.attributes[GenAiAttr.CONVERSATION_ID]);
		if (conversationId && conversationId !== sessionId) {
			let traces = this._sessionTraces.get(conversationId);
			if (!traces) {
				traces = new Set();
				this._sessionTraces.set(conversationId, traces);
			}
			traces.add(traceId);
		}

		// Associate this trace with any active VS Code session that has a debug panel open
		// This bridges the gap between VS Code's session ID and the extension's conversation ID
		for (const activeSessionId of this._activeSessionIds) {
			let traces = this._sessionTraces.get(activeSessionId);
			if (!traces) {
				traces = new Set();
				this._sessionTraces.set(activeSessionId, traces);
			}
			traces.add(traceId);
		}

		// Convert to debug event and stream to all active listeners
		const debugEvent = completedSpanToDebugEvent(span);
		if (debugEvent) {
			for (const progress of this._activeStreams.values()) {
				progress.report(debugEvent);
			}
		}

		// Extract agent response events from completed chat spans
		// (User messages are streamed in real-time via onDidEmitSpanEvent, not here)
		const conversationEvents = extractConversationEvents([span]);
		for (const evt of conversationEvents) {
			if (evt instanceof vscode.ChatDebugAgentResponseEvent) {
				for (const progress of this._activeStreams.values()) {
					progress.report(evt);
				}
			}
		}
	}

	private _onSpanEvent(event: ISpanEventData): void {
		if (event.eventName !== 'user_message') {
			return;
		}
		// Only emit if content is non-empty (skip retry spans, title generation, etc.)
		const content = event.attributes.content;
		if (!content || (typeof content === 'string' && !content.trim())) {
			return;
		}
		const userMsgEvt = spanEventToUserMessage(event);
		if (!userMsgEvt) {
			return;
		}
		// Stream to all active listeners (we don't know the session yet for span events)
		for (const progress of this._activeStreams.values()) {
			progress.report(userMsgEvt);
		}
	}

	/**
	 * Find all spans for a session by checking the sessionId→traceId mapping,
	 * and falling back to scanning all traces for matching session IDs.
	 */
	private _getSpansForSession(sessionId: string): ICompletedSpanData[] | undefined {
		// Collect spans from ALL traces associated with this session
		const traceIds = this._sessionTraces.get(sessionId);
		if (traceIds && traceIds.size > 0) {
			const allSpans: ICompletedSpanData[] = [];
			for (const tid of traceIds) {
				const spans = this._traceSpans.get(tid);
				if (spans) {
					allSpans.push(...spans);
				}
			}
			if (allSpans.length > 0) {
				return allSpans;
			}
		}

		// Slow path: scan all traces for spans with this session ID
		for (const [tid, spans] of this._traceSpans) {
			for (const span of spans) {
				if (extractSessionId(span) === sessionId) {
					let traces = this._sessionTraces.get(sessionId);
					if (!traces) {
						traces = new Set();
						this._sessionTraces.set(sessionId, traces);
					}
					traces.add(tid);
					// Continue scanning to find all matching traces
				}
			}
		}

		// Try again after scanning
		const foundTraces = this._sessionTraces.get(sessionId);
		if (foundTraces && foundTraces.size > 0) {
			const allSpans: ICompletedSpanData[] = [];
			for (const tid of foundTraces) {
				const spans = this._traceSpans.get(tid);
				if (spans) {
					allSpans.push(...spans);
				}
			}
			return allSpans.length > 0 ? allSpans : undefined;
		}
		return undefined;
	}

	private _provideChatDebugLog(
		sessionResource: vscode.Uri,
		progress: vscode.Progress<vscode.ChatDebugEvent>,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.ChatDebugEvent[]> {
		const sessionId = decodeSessionId(sessionResource);

		// Register progress for streaming new events and track this as an active session
		this._activeStreams.set(sessionId, progress);
		this._activeSessionIds.add(sessionId);
		token.onCancellationRequested(() => {
			this._activeStreams.delete(sessionId);
			this._activeSessionIds.delete(sessionId);
		});

		// If no spans found yet for this VS Code session ID, associate ALL current traces
		// This handles the case where the debug panel opens after spans have already been created
		// with a different session ID (extension's conversation ID != VS Code's session ID)
		if (!this._sessionTraces.has(sessionId) || this._sessionTraces.get(sessionId)!.size === 0) {
			const allTraceIds = new Set<string>();
			for (const tid of this._traceSpans.keys()) {
				allTraceIds.add(tid);
			}
			if (allTraceIds.size > 0) {
				this._sessionTraces.set(sessionId, allTraceIds);
			}
		}

		// Check for imported sessions first
		const importedSpans = this._importedSessions.get(sessionId);
		if (importedSpans) {
			return this._convertSpansToEvents(importedSpans);
		}

		// Look up traceId for this session, then return all spans in that trace
		const spans = this._getSpansForSession(sessionId);
		if (!spans || spans.length === 0) {
			return [];
		}

		return this._convertSpansToEvents(spans);
	}

	private _convertSpansToEvents(spans: readonly ICompletedSpanData[]): vscode.ChatDebugEvent[] {
		const events: vscode.ChatDebugEvent[] = [];

		// Convert each span to its event type (tool calls, model turns, subagent invocations)
		for (const span of spans) {
			const evt = completedSpanToDebugEvent(span);
			if (evt) {
				events.push(evt);
			}
		}

		// Extract user messages from span events (recorded during chat span creation)
		for (const span of spans) {
			for (const spanEvent of span.events) {
				if (spanEvent.name === 'user_message') {
					const content = spanEvent.attributes?.content;
					if (content && typeof content === 'string' && content.trim()) {
						const evt = new vscode.ChatDebugUserMessageEvent(
							content.length > 200 ? content.slice(0, 200) + '...' : content,
							new Date(spanEvent.timestamp),
						);
						evt.id = `user-msg-${span.spanId}`;
						evt.parentEventId = span.parentSpanId;
						events.push(evt);
					}
				}
			}
		}

		// Extract agent response events from completed chat spans
		events.push(...extractConversationEvents(spans));

		// Sort by timestamp
		events.sort((a, b) => {
			const aTime = 'created' in a ? (a as { created: Date }).created.getTime() : 0;
			const bTime = 'created' in b ? (b as { created: Date }).created.getTime() : 0;
			return aTime - bTime;
		});

		return events;
	}

	private _resolveChatDebugLogEvent(
		eventId: string,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.ChatDebugResolvedEventContent> {
		// Route by event ID prefix
		if (eventId.startsWith('user-msg-')) {
			const spanId = eventId.slice('user-msg-'.length);
			const span = this._findSpanById(spanId);
			if (span) {
				return resolveUserMessageFromSpan(span);
			}
		}

		if (eventId.startsWith('agent-msg-')) {
			const spanId = eventId.slice('agent-msg-'.length);
			const span = this._findSpanById(spanId);
			if (span) {
				return resolveAgentResponseFromSpan(span);
			}
		}

		// Direct span ID lookup for tool calls and model turns
		const span = this._findSpanById(eventId);
		if (span) {
			return resolveSpanToContent(span);
		}

		return undefined;
	}

	private _findSpanById(spanId: string): ICompletedSpanData | undefined {
		for (const spans of this._traceSpans.values()) {
			const found = spans.find(s => s.spanId === spanId);
			if (found) { return found; }
		}
		for (const spans of this._importedSessions.values()) {
			const found = spans.find(s => s.spanId === spanId);
			if (found) { return found; }
		}
		return undefined;
	}

	// ── Export / Import ──

	/**
	 * Export a debug session to OTLP JSON format with Copilot extension metadata.
	 */
	private _provideChatDebugLogExport(
		sessionResource: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<Uint8Array> {
		const sessionId = decodeSessionId(sessionResource);
		const spans = this._getSpansForSession(sessionId) ?? this._importedSessions.get(sessionId);
		if (!spans || spans.length === 0) {
			this._logService.warn(`[OTelDebug] No spans found for session ${sessionId}`);
			return undefined;
		}

		const otlpExport = wrapInResourceSpans(spans, {
			'service.name': 'copilot-chat',
			'session.id': sessionId,
		});

		const exportData: ChatDebugLogExport = {
			...otlpExport,
			copilotChat: {
				exportedAt: new Date().toISOString(),
				exporterVersion: '',
				sessionId,
			},
		};

		const json = JSON.stringify(exportData, null, 2);
		return new TextEncoder().encode(json);
	}

	/**
	 * Import a previously exported debug log from a serialized byte array.
	 */
	private _resolveChatDebugLogImport(
		data: Uint8Array,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.Uri> {
		try {
			const jsonString = new TextDecoder().decode(data);
			const parsed = JSON.parse(jsonString);

			if (!parsed.resourceSpans) {
				this._logService.warn('[OTelDebug] Import file does not contain resourceSpans');
				return undefined;
			}

			const spans = parseResourceSpans(jsonString);
			if (spans.length === 0) {
				this._logService.warn('[OTelDebug] No spans found in imported file');
				return undefined;
			}

			const sourceSessionId = parsed.copilotChat?.sessionId
				?? extractSessionId(spans[0])
				?? `imported-${Date.now()}`;

			// Use a unique ID for the imported session to avoid collision with live sessions
			const importedSessionId = `import:${sourceSessionId}:${Date.now()}`;
			this._importedSessions.set(importedSessionId, spans);

			// Return a URI that decodeSessionId() can decode back to the importedSessionId
			const encoded = Buffer.from(importedSessionId).toString('base64');
			const uri = vscode.Uri.parse(`vscode-chat-session://imported/${encoded}`);
			return uri;
		} catch (err) {
			this._logService.error(`[OTelDebug] Failed to parse import file: ${err}`);
			return undefined;
		}
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}
