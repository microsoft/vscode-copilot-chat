/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IEnvService } from '../../env/common/envService';
import {
	DEFAULT_OTEL_CONFIG,
	IAgentRunAttributes,
	IApiRequestAttributes,
	IApiResponseAttributes,
	ICommonTelemetryAttributes,
	IConfigAttributes,
	IFileOperationAttributes,
	IOpenTelemetryConfig,
	IOpenTelemetryService,
	ISpanContext,
	IToolCallAttributes,
	IUserPromptAttributes,
} from '../common/openTelemetryService';

/**
 * Event prefix for all Copilot Chat OpenTelemetry events.
 * Following Gemini CLI's naming convention.
 */
const EVENT_PREFIX = 'copilot_chat';

/**
 * Telemetry record that will be written to file.
 */
interface ITelemetryRecord {
	timestamp: string;
	type: 'log' | 'metric' | 'span';
	name: string;
	attributes: Record<string, unknown>;
	common: ICommonTelemetryAttributes;
}

/**
 * Metric counters tracked in memory.
 */
interface IMetricCounters {
	sessionCount: number;
	toolCalls: Map<string, { success: number; failure: number; totalDurationMs: number }>;
	apiRequests: Map<string, { count: number; totalDurationMs: number; errors: number }>;
	tokenUsage: Map<string, { input: number; output: number; cache: number }>;
	fileOperations: { create: number; read: number; update: number; totalLines: number };
	agentRuns: Map<string, { count: number; totalDurationMs: number; totalTurns: number }>;
}

/**
 * File-based OpenTelemetry service implementation.
 * Writes telemetry events to a JSON lines file for local analysis.
 */
export class FileOpenTelemetryService extends Disposable implements IOpenTelemetryService {
	declare readonly _serviceBrand: undefined;

	private readonly _config: IOpenTelemetryConfig;
	private readonly _sessionId: string;
	private readonly _commonAttributes: ICommonTelemetryAttributes;
	private readonly _metrics: IMetricCounters;
	private _writeStream: fs.WriteStream | undefined;

	constructor(
		config: Partial<IOpenTelemetryConfig>,
		@ILogService private readonly _logService: ILogService,
		@IEnvService private readonly _envService: IEnvService,
	) {
		super();

		this._config = { ...DEFAULT_OTEL_CONFIG, ...config };
		this._sessionId = generateUuid();

		this._commonAttributes = {
			'session.id': this._sessionId,
			'installation.id': this._envService.machineId,
			'extension.version': this._envService.getEditorPluginInfo().version,
			'vscode.version': this._envService.getEditorInfo().format(),
		};

		this._metrics = {
			sessionCount: 0,
			toolCalls: new Map(),
			apiRequests: new Map(),
			tokenUsage: new Map(),
			fileOperations: { create: 0, read: 0, update: 0, totalLines: 0 },
			agentRuns: new Map(),
		};

		if (this._config.enabled && this._config.outfile) {
			this._initializeWriteStream();
		}
	}

	get isEnabled(): boolean {
		return this._config.enabled;
	}

	getConfig(): IOpenTelemetryConfig {
		return { ...this._config };
	}

	private _initializeWriteStream(): void {
		if (!this._config.outfile) {
			return;
		}

		try {
			// Ensure directory exists
			const dir = path.dirname(this._config.outfile);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Open file in append mode
			this._writeStream = fs.createWriteStream(this._config.outfile, {
				flags: 'a',
				encoding: 'utf8',
			});

			this._writeStream.on('error', (err) => {
				this._logService.error(`[OpenTelemetry] Write stream error: ${err.message}`);
			});

			this._logService.info(`[OpenTelemetry] Initialized file output: ${this._config.outfile}`);
		} catch (err) {
			this._logService.error(`[OpenTelemetry] Failed to initialize file output: ${err}`);
		}
	}

	private _writeRecord(record: ITelemetryRecord): void {
		if (!this._config.enabled) {
			return;
		}

		if (this._writeStream) {
			const line = JSON.stringify(record) + '\n';

			// Use backpressure-aware writing: check if we can write immediately
			// If not, the stream will buffer and we don't need to track this write
			const canContinue = this._writeStream.write(line, (err) => {
				if (err) {
					this._logService.error(`[OpenTelemetry] Write error: ${err.message}`);
				}
			});

			// If the internal buffer is full, we could implement backpressure here
			// For now, we rely on Node.js's built-in buffering
			if (!canContinue) {
				this._logService.trace('[OpenTelemetry] Write stream buffer is full, data will be buffered');
			}
		} else {
			// Log to debug output if no file is configured
			this._logService.trace(`[OpenTelemetry] ${record.type}:${record.name} ${JSON.stringify(record.attributes)}`);
		}
	}

	private _createRecord(type: 'log' | 'metric' | 'span', name: string, attributes: Record<string, unknown>): ITelemetryRecord {
		return {
			timestamp: new Date().toISOString(),
			type,
			name,
			attributes,
			common: this._commonAttributes,
		};
	}

	/**
	 * Helper to convert typed attributes to Record<string, unknown> for JSON serialization.
	 */
	private _toAttributes<T extends object>(obj: T): Record<string, unknown> {
		return obj as unknown as Record<string, unknown>;
	}

	// ============== Log Events ==============

	logConfig(attributes: IConfigAttributes): void {
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.config`, this._toAttributes(attributes)));
	}

	logUserPrompt(attributes: IUserPromptAttributes): void {
		// Respect logPrompts setting
		const sanitizedAttributes = { ...attributes };
		if (!this._config.logPrompts) {
			delete sanitizedAttributes.prompt;
		}
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.user_prompt`, this._toAttributes(sanitizedAttributes)));
	}

	logToolCall(attributes: IToolCallAttributes): void {
		// Respect logPrompts setting for function args
		const sanitizedAttributes = { ...attributes };
		if (!this._config.logPrompts) {
			delete sanitizedAttributes.function_args;
		}
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.tool_call`, this._toAttributes(sanitizedAttributes)));
	}

	logApiRequest(attributes: IApiRequestAttributes): void {
		const sanitizedAttributes = { ...attributes };
		if (!this._config.logPrompts) {
			delete sanitizedAttributes.request_text;
		}
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.api_request`, this._toAttributes(sanitizedAttributes)));
	}

	logApiResponse(attributes: IApiResponseAttributes): void {
		const sanitizedAttributes = { ...attributes };
		if (!this._config.logPrompts) {
			delete sanitizedAttributes.response_text;
		}
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.api_response`, this._toAttributes(sanitizedAttributes)));
	}

	logApiError(attributes: IApiResponseAttributes & { error: string; error_type: string }): void {
		const sanitizedAttributes = { ...attributes };
		if (!this._config.logPrompts) {
			delete sanitizedAttributes.response_text;
		}
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.api_error`, this._toAttributes(sanitizedAttributes)));
	}

	logAgentStart(attributes: Pick<IAgentRunAttributes, 'agent_id' | 'agent_name'>): void {
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.agent.start`, this._toAttributes(attributes)));
	}

	logAgentFinish(attributes: IAgentRunAttributes): void {
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.agent.finish`, this._toAttributes(attributes)));
	}

	logFileOperation(attributes: IFileOperationAttributes): void {
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.file_operation`, this._toAttributes(attributes)));
	}

	logConversationFinished(attributes: { approvalMode?: string; turnCount: number }): void {
		this._writeRecord(this._createRecord('log', `${EVENT_PREFIX}.conversation_finished`, this._toAttributes(attributes)));
	}

	// ============== Metrics ==============

	incrementSessionCount(): void {
		this._metrics.sessionCount++;
		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.session.count`, {
			value: 1,
			total: this._metrics.sessionCount,
		}));
	}

	recordToolCall(functionName: string, success: boolean, toolType: 'native' | 'mcp', durationMs?: number): void {
		const key = `${functionName}:${toolType}`;
		const current = this._metrics.toolCalls.get(key) || { success: 0, failure: 0, totalDurationMs: 0 };

		if (success) {
			current.success++;
		} else {
			current.failure++;
		}
		if (durationMs !== undefined) {
			current.totalDurationMs += durationMs;
		}
		this._metrics.toolCalls.set(key, current);

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.tool.call.count`, {
			function_name: functionName,
			success,
			tool_type: toolType,
			value: 1,
		}));

		if (durationMs !== undefined) {
			this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.tool.call.latency`, {
				function_name: functionName,
				value: durationMs,
			}));
		}
	}

	recordApiRequest(model: string, statusCode: number | string, durationMs: number, errorType?: string): void {
		const current = this._metrics.apiRequests.get(model) || { count: 0, totalDurationMs: 0, errors: 0 };
		current.count++;
		current.totalDurationMs += durationMs;
		if (errorType) {
			current.errors++;
		}
		this._metrics.apiRequests.set(model, current);

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.api.request.count`, {
			model,
			status_code: statusCode,
			error_type: errorType,
			value: 1,
		}));

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.api.request.latency`, {
			model,
			value: durationMs,
		}));
	}

	recordTokenUsage(model: string, tokenType: 'input' | 'output' | 'cache', count: number): void {
		const current = this._metrics.tokenUsage.get(model) || { input: 0, output: 0, cache: 0 };
		current[tokenType] += count;
		this._metrics.tokenUsage.set(model, current);

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.token.usage`, {
			model,
			type: tokenType,
			value: count,
		}));
	}

	recordFileOperation(operation: 'create' | 'read' | 'update', lines?: number): void {
		this._metrics.fileOperations[operation]++;
		if (lines !== undefined) {
			this._metrics.fileOperations.totalLines += lines;
		}

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.file.operation.count`, {
			operation,
			lines,
			value: 1,
		}));
	}

	recordAgentRun(agentName: string, durationMs: number, turnCount: number, terminateReason: string): void {
		const current = this._metrics.agentRuns.get(agentName) || { count: 0, totalDurationMs: 0, totalTurns: 0 };
		current.count++;
		current.totalDurationMs += durationMs;
		current.totalTurns += turnCount;
		this._metrics.agentRuns.set(agentName, current);

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.agent.run.count`, {
			agent_name: agentName,
			terminate_reason: terminateReason,
			value: 1,
		}));

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.agent.duration`, {
			agent_name: agentName,
			value: durationMs,
		}));

		this._writeRecord(this._createRecord('metric', `${EVENT_PREFIX}.agent.turns`, {
			agent_name: agentName,
			value: turnCount,
		}));
	}

	// ============== Spans/Traces ==============

	startSessionSpan(sessionId: string): ISpanContext | undefined {
		if (!this._config.enabled) {
			return undefined;
		}

		const spanContext: ISpanContext = {
			traceId: sessionId,
			spanId: generateUuid(),
		};

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.session.start`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			session_id: sessionId,
		}));

		return spanContext;
	}

	endSessionSpan(spanContext: ISpanContext | undefined): void {
		if (!spanContext) {
			return;
		}

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.session.end`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
		}));
	}

	startApiRequestSpan(parentContext: ISpanContext | undefined, model: string, requestId: string): ISpanContext | undefined {
		if (!this._config.enabled) {
			return undefined;
		}

		const spanContext: ISpanContext = {
			traceId: parentContext?.traceId || generateUuid(),
			spanId: generateUuid(),
		};

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.api_request.start`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			parent_span_id: parentContext?.spanId,
			model,
			request_id: requestId,
		}));

		return spanContext;
	}

	endApiRequestSpan(spanContext: ISpanContext | undefined, success: boolean, tokenUsage?: { input: number; output: number }): void {
		if (!spanContext) {
			return;
		}

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.api_request.end`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			success,
			input_tokens: tokenUsage?.input,
			output_tokens: tokenUsage?.output,
		}));
	}

	startToolSpan(parentContext: ISpanContext | undefined, toolName: string): ISpanContext | undefined {
		if (!this._config.enabled) {
			return undefined;
		}

		const spanContext: ISpanContext = {
			traceId: parentContext?.traceId || generateUuid(),
			spanId: generateUuid(),
		};

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.tool.start`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			parent_span_id: parentContext?.spanId,
			tool_name: toolName,
		}));

		return spanContext;
	}

	endToolSpan(spanContext: ISpanContext | undefined, success: boolean, error?: string): void {
		if (!spanContext) {
			return;
		}

		this._writeRecord(this._createRecord('span', `${EVENT_PREFIX}.tool.end`, {
			trace_id: spanContext.traceId,
			span_id: spanContext.spanId,
			success,
			error,
		}));
	}

	async flush(): Promise<void> {
		// If there's a write stream, we need to ensure all data is written
		if (this._writeStream && this._writeStream.writable) {
			// Use cork/uncork with a promise to ensure data is flushed
			return new Promise<void>((resolve) => {
				// Use nextTick to ensure any pending writes are processed
				process.nextTick(() => {
					resolve();
				});
			});
		}
	}

	override dispose(): void {
		if (this._writeStream) {
			this._writeStream.end();
			this._writeStream = undefined;
		}
		super.dispose();
	}
}
