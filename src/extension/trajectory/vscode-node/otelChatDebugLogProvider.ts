/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService, type ICompletedSpanData, type ISpanEventData } from '../../../platform/otel/common/otelService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
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

let nextCoreEventId = 1;

/**
 * Convert a VS Code core debug event into a synthetic ICompletedSpanData
 * so it can be stored alongside OTel spans and included in export/import.
 */
function coreEventToSpan(event: vscode.ChatDebugEvent, traceId: string): ICompletedSpanData | undefined {
	const id = `core-${(nextCoreEventId++).toString(16).padStart(16, '0')}`;
	const timestamp = 'created' in event ? (event as { created: Date }).created.getTime() : Date.now();
	const attributes: Record<string, string | number | boolean | string[]> = {
		'copilot_chat.source': 'core',
	};

	if (event instanceof vscode.ChatDebugGenericEvent) {
		attributes['gen_ai.operation.name'] = 'core_event';
		attributes['copilot_chat.debug_name'] = event.name;
		if (event.details) { attributes['copilot_chat.event_details'] = event.details; }
		if (event.category) { attributes['copilot_chat.event_category'] = event.category; }
		attributes['copilot_chat.log_level'] = event.level;
	} else if (event instanceof vscode.ChatDebugToolCallEvent) {
		attributes['gen_ai.operation.name'] = 'execute_tool';
		attributes['gen_ai.tool.name'] = event.toolName;
		if (event.input) { attributes['gen_ai.tool.call.arguments'] = event.input; }
		if (event.output) { attributes['gen_ai.tool.call.result'] = event.output; }
	} else if (event instanceof vscode.ChatDebugModelTurnEvent) {
		attributes['gen_ai.operation.name'] = 'chat';
		if (event.model) { attributes['gen_ai.request.model'] = event.model; }
		if (event.inputTokens !== undefined) { attributes['gen_ai.usage.input_tokens'] = event.inputTokens; }
		if (event.outputTokens !== undefined) { attributes['gen_ai.usage.output_tokens'] = event.outputTokens; }
	} else {
		// Unknown event type — store as generic
		attributes['gen_ai.operation.name'] = 'core_event';
	}

	// Preserve the event ID and parent for hierarchy
	const eventId = 'id' in event ? (event as { id?: string }).id : undefined;
	const parentEventId = 'parentEventId' in event ? (event as { parentEventId?: string }).parentEventId : undefined;

	return {
		name: attributes['copilot_chat.debug_name'] as string ?? 'core-event',
		spanId: eventId ?? id,
		traceId,
		parentSpanId: parentEventId,
		startTime: timestamp,
		endTime: timestamp,
		status: { code: 0 /* UNSET */ },
		attributes,
		events: [],
	};
}

/**
 * OTel-first ChatDebugLogProvider.
 * Single data source: IOTelService spans (via onDidCompleteSpan / onDidEmitSpanEvent).
 *
 * Replaces the previous 3-source architecture (IRequestLogger + ITrajectoryLogger + IAgentDebugEventService).
 */
export class OTelChatDebugLogProviderContribution extends Disposable implements IExtensionContribution {
	public readonly id = 'otelChatDebugLogProvider';

	/** Maximum number of spans to keep in memory across all sessions */
	private static readonly MAX_SPANS = 10_000;

	/** ALL completed spans, in order */
	private readonly _allSpans: ICompletedSpanData[] = [];

	/** Maps VS Code chat session ID → list of span indices */
	private readonly _sessionSpanIndices = new Map<string, number[]>();

	/** Session IDs in order of creation (for eviction) */
	private readonly _sessionOrder: string[] = [];

	/** Currently active VS Code session ID */
	private _activeSessionId: string | undefined;

	/** Most recently seen traceId — used for trace context */
	private _lastTraceId = 'default-trace';

	/** Index from spanId → position in _allSpans for O(1) lookup */
	private readonly _spanIdIndex = new Map<string, number>();

	/** Imported sessions (from file import) */
	private readonly _importedSessions = new Map<string, ICompletedSpanData[]>();

	/** Active progress callback for streaming events */
	private _activeProgress: vscode.Progress<vscode.ChatDebugEvent> | undefined;

	/** Track event IDs already sent to prevent duplicates */
	private readonly _sentEventIds = new Set<string>();

	constructor(
		@IOTelService private readonly _otelService: IOTelService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
		super();

		if (!this._configurationService.getExperimentBasedConfig(ConfigKey.AgentDebugLogEnabled, this._experimentationService)) {
			return;
		}

		// Listen for completed spans and bucket by session
		this._register(this._otelService.onDidCompleteSpan(span => {
			this._onSpanCompleted(span);
		}));

		// Listen for span events for real-time user message streaming
		this._register(this._otelService.onDidEmitSpanEvent(event => {
			this._onSpanEvent(event);
		}));

		// Register as the debug log provider (guard for proposed API availability)
		if (typeof vscode.chat?.registerChatDebugLogProvider !== 'function') {
			this._logService.info('[OTelDebug] Chat debug API not available, skipping registration');
			return;
		}

		try {
			this._register(vscode.chat.registerChatDebugLogProvider({
				provideChatDebugLog: (sessionResource, progress, token) =>
					this._provideChatDebugLog(sessionResource, progress, token),
				resolveChatDebugLogEvent: (eventId, token) =>
					this._resolveChatDebugLogEvent(eventId, token),
				provideChatDebugLogExport: (sessionResource, options, token) =>
					this._provideChatDebugLogExport(sessionResource, options, token),
				resolveChatDebugLogImport: (data, token) =>
					this._resolveChatDebugLogImport(data, token),
			}));
		} catch (e) {
			this._logService.warn(`[OTelDebug] Failed to register debug log provider: ${e}`);
		}
	}

	private _onSpanCompleted(span: ICompletedSpanData): void {
		if (!span.traceId) { return; }

		this._lastTraceId = span.traceId;
		this._addSpan(span);

		// Only create debug events if the panel is actively listening
		if (!this._activeProgress) { return; }

		// Stream to active debug panel
		const debugEvent = completedSpanToDebugEvent(span);
		if (debugEvent) {
			this._streamEvent(debugEvent);
		}

		// Stream agent response events
		const conversationEvents = extractConversationEvents([span]);
		for (const evt of conversationEvents) {
			if (evt instanceof vscode.ChatDebugAgentResponseEvent) {
				this._streamEvent(evt);
			}
		}
	}

	/**
	 * Add a span to storage with bounded eviction.
	 * When MAX_SPANS is exceeded, evicts the oldest session's spans.
	 */
	private _addSpan(span: ICompletedSpanData): void {
		// Determine session ID — use attribute, fall back to active session
		let chatSessionId = asString(span.attributes['copilot_chat.chat_session_id']);
		if (!chatSessionId && this._activeSessionId) {
			chatSessionId = this._activeSessionId;
			// Clone span with injected session ID to avoid mutating the original
			span = {
				...span,
				attributes: { ...span.attributes, 'copilot_chat.chat_session_id': chatSessionId },
			};
		}

		const spanIndex = this._allSpans.length;
		this._allSpans.push(span);
		this._spanIdIndex.set(span.spanId, spanIndex);

		if (chatSessionId) {
			let indices = this._sessionSpanIndices.get(chatSessionId);
			if (!indices) {
				indices = [];
				this._sessionSpanIndices.set(chatSessionId, indices);
				this._sessionOrder.push(chatSessionId);
			}
			indices.push(spanIndex);
		}

		this._evictIfNeeded();
	}

	private _evictIfNeeded(): void {
		if (this._allSpans.length <= OTelChatDebugLogProviderContribution.MAX_SPANS) {
			return;
		}

		// Evict oldest sessions until under limit (skip active session)
		let evicted = false;
		while (this._sessionOrder.length > 1 && this._allSpans.length > OTelChatDebugLogProviderContribution.MAX_SPANS) {
			const oldest = this._sessionOrder[0];
			if (oldest === this._activeSessionId) { break; }
			this._sessionOrder.shift();
			this._sessionSpanIndices.delete(oldest);
			evicted = true;
		}

		// If still over limit (single/active session), drop oldest spans within each remaining session
		if (this._allSpans.length > OTelChatDebugLogProviderContribution.MAX_SPANS) {
			const excess = this._allSpans.length - OTelChatDebugLogProviderContribution.MAX_SPANS;
			let toDrop = excess;
			for (const sessionId of this._sessionOrder) {
				if (toDrop <= 0) { break; }
				const indices = this._sessionSpanIndices.get(sessionId);
				if (!indices || indices.length === 0) { continue; }
				const dropFromSession = Math.min(toDrop, indices.length - 1); // keep at least 1 span
				if (dropFromSession > 0) {
					indices.splice(0, dropFromSession);
					toDrop -= dropFromSession;
					evicted = true;
				}
			}
		}

		// Schedule async compaction to avoid blocking the main thread
		if (evicted && !this._compactionScheduled) {
			this._compactionScheduled = true;
			setTimeout(() => {
				this._compactionScheduled = false;
				this._compact();
			}, 0);
		}
	}

	private _compactionScheduled = false;

	/**
	 * Compact in-place: remove unreachable spans, remap indices.
	 * Runs asynchronously (via setTimeout) to avoid blocking user operations.
	 */
	private _compact(): void {
		// Build reachable set
		const reachable = new Set<number>();
		for (const indices of this._sessionSpanIndices.values()) {
			for (let i = 0; i < indices.length; i++) {
				reachable.add(indices[i]);
			}
		}

		// Nothing to compact if all spans are reachable
		if (reachable.size === this._allSpans.length) { return; }

		// Single-pass in-place compaction
		let writePos = 0;
		const remap = new Int32Array(this._allSpans.length);
		remap.fill(-1);
		for (let i = 0; i < this._allSpans.length; i++) {
			if (reachable.has(i)) {
				this._allSpans[writePos] = this._allSpans[i];
				remap[i] = writePos;
				writePos++;
			}
		}
		this._allSpans.length = writePos;

		// Remap session indices in-place
		for (const indices of this._sessionSpanIndices.values()) {
			for (let i = 0; i < indices.length; i++) {
				indices[i] = remap[indices[i]];
			}
		}

		// Rebuild spanId index after compaction
		this._spanIdIndex.clear();
		for (let i = 0; i < this._allSpans.length; i++) {
			this._spanIdIndex.set(this._allSpans[i].spanId, i);
		}
	}

	private _streamEvent(evt: vscode.ChatDebugEvent): void {
		if (!this._activeProgress) { return; }
		const evtId = 'id' in evt ? (evt as { id?: string }).id : undefined;
		if (evtId) {
			if (this._sentEventIds.has(evtId)) { return; }
			this._sentEventIds.add(evtId);
		}
		this._activeProgress.report(evt);
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
		this._streamEvent(userMsgEvt);
	}

	private _getSpansForSession(sessionId: string): ICompletedSpanData[] | undefined {
		const indices = this._sessionSpanIndices.get(sessionId);
		if (!indices || indices.length === 0) { return undefined; }
		return indices.map(i => this._allSpans[i]);
	}

	private _provideChatDebugLog(
		sessionResource: vscode.Uri,
		progress: vscode.Progress<vscode.ChatDebugEvent>,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.ChatDebugEvent[]> {
		const sessionId = decodeSessionId(sessionResource);

		// Set this as the active session
		this._activeProgress = progress;
		this._activeSessionId = sessionId;
		this._sentEventIds.clear();

		token.onCancellationRequested(() => {
			if (this._activeSessionId === sessionId) {
				this._activeProgress = undefined;
				this._activeSessionId = undefined;
			}
		});

		// Check for imported sessions first
		const importedSpans = this._importedSessions.get(sessionId);
		if (importedSpans) {
			return this._convertSpansToEvents(importedSpans);
		}

		// Get spans for this session from all its ranges
		const sessionSpans = this._getSpansForSession(sessionId);
		if (!sessionSpans || sessionSpans.length === 0) {
			return [];
		}

		// Return only extension spans — core events are displayed by core directly
		const events = this._convertSpansToEvents(sessionSpans);

		// Mark returned event IDs as sent to prevent re-streaming
		for (const evt of events) {
			const evtId = 'id' in evt ? (evt as { id?: string }).id : undefined;
			if (evtId) { this._sentEventIds.add(evtId); }
		}

		return events;
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
		const idx = this._spanIdIndex.get(spanId);
		if (idx !== undefined && idx < this._allSpans.length) {
			const span = this._allSpans[idx];
			if (span.spanId === spanId) { return span; }
		}
		// Fallback: linear scan (index may be stale after compaction)
		const found = this._allSpans.find(s => s.spanId === spanId);
		if (found) { return found; }
		for (const spans of this._importedSessions.values()) {
			const found = spans.find(s => s.spanId === spanId);
			if (found) { return found; }
		}
		return undefined;
	}

	// ── Export / Import ──

	/**
	 * Export a debug session to OTLP JSON format with Copilot extension metadata.
	 * Core events are passed in at export time (not streamed live).
	 */
	private _provideChatDebugLogExport(
		sessionResource: vscode.Uri,
		options: vscode.ChatDebugLogExportOptions,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<Uint8Array> {
		const sessionId = decodeSessionId(sessionResource);
		const extensionSpans = this._getSpansForSession(sessionId) ?? [];
		const importedSpans = this._importedSessions.get(sessionId);

		// Convert core events to spans for export
		const coreSpans: ICompletedSpanData[] = [];
		for (const event of options.coreEvents) {
			const span = coreEventToSpan(event, this._lastTraceId);
			if (span) {
				coreSpans.push(span);
			}
		}

		const spans = importedSpans ?? [...extensionSpans, ...coreSpans];
		if (spans.length === 0) {
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
				sessionTitle: options.sessionTitle ?? deriveSessionTitle(spans),
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
	): vscode.ProviderResult<vscode.ChatDebugLogImportResult> {
		try {
			const jsonString = new TextDecoder().decode(data);

			// Parse spans — supports both single JSON object and JSONL format
			const spans = parseResourceSpans(jsonString);
			if (spans.length === 0) {
				this._logService.warn('[OTelDebug] No spans found in imported file');
				return undefined;
			}

			// Extract session ID and title from copilotChat extension (if present)
			let sourceSessionId: string | undefined;
			let sessionTitle: string | undefined;
			try {
				const parsed = JSON.parse(jsonString);
				sourceSessionId = parsed.copilotChat?.sessionId;
				sessionTitle = parsed.copilotChat?.sessionTitle;
			} catch { /* JSONL format — no top-level object */ }
			sourceSessionId ??= extractSessionId(spans[0]) ?? `imported-${Date.now()}`;
			sessionTitle ??= deriveSessionTitle(spans);

			// Use a unique ID for the imported session to avoid collision with live sessions
			const importedSessionId = `import:${sourceSessionId}:${Date.now()}`;
			this._importedSessions.set(importedSessionId, spans);

			// Return a URI that decodeSessionId() can decode back to the importedSessionId
			const encoded = Buffer.from(importedSessionId).toString('base64');
			const uri = vscode.Uri.parse(`vscode-chat-session://imported/${encoded}`);
			return { uri, sessionTitle };
		} catch (err) {
			this._logService.error(`[OTelDebug] Failed to parse import file: ${err}`);
			return undefined;
		}
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

/**
 * Derive a human-readable session title from spans.
 * Uses the first user message content, truncated.
 */
function deriveSessionTitle(spans: readonly ICompletedSpanData[]): string | undefined {
	for (const span of spans) {
		for (const event of span.events) {
			if (event.name === 'user_message') {
				const content = event.attributes?.content;
				if (typeof content === 'string' && content.trim()) {
					const title = content.trim();
					return title.length > 80 ? title.slice(0, 80) + '...' : title;
				}
			}
		}
	}
	return undefined;
}
