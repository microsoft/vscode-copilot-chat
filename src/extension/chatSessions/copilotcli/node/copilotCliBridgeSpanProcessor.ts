/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotChatAttr } from '../../../../platform/otel/common/genAiAttributes';
import type { ICompletedSpanData, IOTelService, ISpanEventRecord, SpanStatusCode } from '../../../../platform/otel/common/otelService';

/**
 * Minimal type for the OTel SDK's ReadableSpan — avoids importing the full
 * @opentelemetry/sdk-trace-base package into the extension bundle.
 */
interface ReadableSpan {
	readonly name: string;
	readonly startTime: readonly [number, number]; // [seconds, nanoseconds]
	readonly endTime: readonly [number, number];
	readonly attributes: Readonly<Record<string, unknown>>;
	readonly events: readonly { readonly name: string; readonly time: readonly [number, number]; readonly attributes?: Readonly<Record<string, unknown>> }[];
	readonly status: { readonly code: number; readonly message?: string };
	/** OTel SDK v2: parent span context object (replaces v1's parentSpanId string) */
	readonly parentSpanContext?: { readonly traceId: string; readonly spanId: string };
	spanContext(): { readonly traceId: string; readonly spanId: string };
}

/**
 * Minimal SpanProcessor interface — matches the OTel SDK's SpanProcessor
 * without requiring the package as a dependency.
 */
export interface SpanProcessor {
	onStart(span: unknown, parentContext: unknown): void;
	onEnd(span: ReadableSpan): void;
	shutdown(): Promise<void>;
	forceFlush(): Promise<void>;
}

/** Convert OTel [seconds, nanoseconds] HrTime to epoch milliseconds. */
function hrTimeToMs(hrTime: readonly [number, number]): number {
	return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/** Flatten OTel attribute values to the types ICompletedSpanData accepts. */
function flattenAttributes(attrs: Readonly<Record<string, unknown>>): Record<string, string | number | boolean | string[]> {
	const result: Record<string, string | number | boolean | string[]> = {};
	for (const [key, value] of Object.entries(attrs)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			result[key] = value;
		} else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
			result[key] = value as string[];
		} else if (value !== null && value !== undefined) {
			result[key] = String(value);
		}
	}
	return result;
}

/**
 * Bridge SpanProcessor that forwards completed spans from the Copilot CLI SDK's
 * OTel TracerProvider into the extension's IOTelService event stream.
 *
 * This allows SDK-native spans (invoke_agent, chat, execute_tool, subagent,
 * permission, hook, etc.) to appear in the Agent Debug Log panel without
 * creating duplicate synthetic spans in the extension.
 *
 * The processor injects `copilot_chat.chat_session_id` on each forwarded span
 * using a traceId → sessionId mapping maintained by the extension.
 */
export class CopilotCliBridgeSpanProcessor implements SpanProcessor {
	/**
	 * Maps OTel traceId → VS Code chat session ID.
	 * Populated when copilotcliSession.ts creates its root `invoke_agent copilotcli` span.
	 */
	private readonly _traceIdToSessionId = new Map<string, string>();
	private _disposed = false;

	constructor(private readonly _otelService: IOTelService) { }

	/** Register a traceId → sessionId mapping for CHAT_SESSION_ID injection. */
	registerTrace(traceId: string, sessionId: string): void {
		this._traceIdToSessionId.set(traceId, sessionId);
	}

	/** Remove a traceId mapping (called when the session request completes). */
	unregisterTrace(traceId: string): void {
		this._traceIdToSessionId.delete(traceId);
	}

	// SpanProcessor interface

	onStart(_span: unknown, _parentContext: unknown): void {
		// Nothing to do on start — we only care about completed spans.
	}

	onEnd(span: ReadableSpan): void {
		if (this._disposed) {
			return;
		}

		const ctx = span.spanContext();
		const sessionId = this._traceIdToSessionId.get(ctx.traceId);

		// Only forward spans that belong to a registered CLI session.
		// This prevents foreground agent spans or other sources from leaking
		// into the CLI session's debug panel bucket.
		if (!sessionId) {
			return;
		}

		const events: ISpanEventRecord[] = span.events.map(event => ({
			name: event.name,
			timestamp: hrTimeToMs(event.time),
			attributes: event.attributes ? flattenAttributes(event.attributes) : undefined,
		}));

		const baseAttributes = flattenAttributes(span.attributes);

		// Inject CHAT_SESSION_ID so the debug panel can bucket this span correctly
		if (sessionId && !baseAttributes[CopilotChatAttr.CHAT_SESSION_ID]) {
			baseAttributes[CopilotChatAttr.CHAT_SESSION_ID] = sessionId;
		}

		const completedSpan: ICompletedSpanData = {
			name: span.name,
			spanId: ctx.spanId,
			traceId: ctx.traceId,
			parentSpanId: span.parentSpanContext?.spanId,
			startTime: hrTimeToMs(span.startTime),
			endTime: hrTimeToMs(span.endTime),
			status: {
				code: span.status.code as SpanStatusCode,
				message: span.status.message,
			},
			attributes: baseAttributes,
			events,
		};

		this._otelService.injectCompletedSpan(completedSpan);
	}

	async shutdown(): Promise<void> {
		this._disposed = true;
		this._traceIdToSessionId.clear();
	}

	async forceFlush(): Promise<void> {
		// No buffering — spans are forwarded synchronously on end.
	}
}
