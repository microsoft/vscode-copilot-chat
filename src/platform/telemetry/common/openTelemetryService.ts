/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';

/**
 * OpenTelemetry configuration options.
 * Based on Gemini CLI's telemetry configuration.
 */
export interface IOpenTelemetryConfig {
	/**
	 * Enable or disable OpenTelemetry instrumentation.
	 * Default: false
	 */
	enabled: boolean;

	/**
	 * Where to send telemetry data: 'local' for file/collector output.
	 * Default: 'local'
	 */
	target: 'local';

	/**
	 * OTLP collector endpoint URL.
	 * Default: 'http://localhost:4317'
	 */
	otlpEndpoint: string;

	/**
	 * OTLP transport protocol.
	 * Default: 'http'
	 */
	otlpProtocol: 'http' | 'grpc';

	/**
	 * Save telemetry to file (overrides otlpEndpoint when set).
	 */
	outfile?: string;

	/**
	 * Include user prompts in telemetry logs.
	 * Default: false (privacy-first)
	 */
	logPrompts: boolean;
}

/**
 * Common attributes included on all telemetry events.
 */
export interface ICommonTelemetryAttributes {
	/** Unique session identifier */
	'session.id': string;
	/** Installation/machine identifier */
	'installation.id': string;
	/** Extension version */
	'extension.version': string;
	/** VS Code version */
	'vscode.version': string;
}

/**
 * Attributes for tool call events.
 */
export interface IToolCallAttributes {
	/** Name of the tool being called */
	function_name: string;
	/** JSON-serialized tool arguments */
	function_args?: string;
	/** Duration of the tool call in milliseconds */
	duration_ms?: number;
	/** Whether the tool call succeeded */
	success: boolean;
	/** User decision for tool approval */
	decision?: 'accept' | 'reject' | 'auto_accept' | 'modify';
	/** Error message if the tool call failed */
	error?: string;
	/** Type of error */
	error_type?: string;
	/** Prompt/request identifier */
	prompt_id?: string;
	/** Type of tool: 'native' or 'mcp' */
	tool_type: 'native' | 'mcp';
	/** MCP server name if applicable */
	mcp_server_name?: string;
}

/**
 * Attributes for API request events.
 */
export interface IApiRequestAttributes {
	/** Model being used */
	model: string;
	/** Prompt/request identifier */
	prompt_id?: string;
	/** Request text (only if logPrompts is enabled) */
	request_text?: string;
}

/**
 * Attributes for API response events.
 */
export interface IApiResponseAttributes {
	/** Model used */
	model: string;
	/** HTTP status code */
	status_code: number | string;
	/** Duration in milliseconds */
	duration_ms: number;
	/** Input token count */
	input_token_count?: number;
	/** Output token count */
	output_token_count?: number;
	/** Cached content token count */
	cached_content_token_count?: number;
	/** Total token count */
	total_token_count?: number;
	/** Response text (only if logPrompts is enabled) */
	response_text?: string;
	/** Prompt/request identifier */
	prompt_id?: string;
	/** Authentication type */
	auth_type?: string;
	/** Finish reasons */
	finish_reasons?: string[];
}

/**
 * Attributes for agent run events.
 */
export interface IAgentRunAttributes {
	/** Unique agent run identifier */
	agent_id: string;
	/** Name of the agent */
	agent_name: string;
	/** Duration in milliseconds (for finish event) */
	duration_ms?: number;
	/** Number of turns (for finish event) */
	turn_count?: number;
	/** Reason for termination (for finish event) */
	terminate_reason?: string;
}

/**
 * Attributes for file operation events.
 */
export interface IFileOperationAttributes {
	/** Tool that performed the operation */
	tool_name: string;
	/** Type of operation */
	operation: 'create' | 'read' | 'update';
	/** Number of lines affected */
	lines?: number;
	/** MIME type of the file */
	mimetype?: string;
	/** File extension */
	extension?: string;
	/** Programming language */
	programming_language?: string;
}

/**
 * Attributes for configuration events.
 */
export interface IConfigAttributes {
	/** Model being used */
	model: string;
	/** Embedding model */
	embedding_model?: string;
	/** Approval mode */
	approval_mode?: string;
	/** Whether debug mode is enabled */
	debug_mode?: boolean;
	/** Number of MCP servers */
	mcp_servers_count?: number;
	/** Output format */
	output_format?: string;
}

/**
 * Attributes for user prompt events.
 */
export interface IUserPromptAttributes {
	/** Length of the prompt */
	prompt_length: number;
	/** Prompt identifier */
	prompt_id: string;
	/** The actual prompt text (only if logPrompts is enabled) */
	prompt?: string;
	/** Authentication type */
	auth_type?: string;
}

/**
 * OpenTelemetry service interface for VS Code Copilot Chat.
 * Provides structured logging, metrics, and tracing capabilities
 * following the OpenTelemetry semantic conventions for GenAI.
 */
export interface IOpenTelemetryService extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * Whether OpenTelemetry instrumentation is currently enabled.
	 */
	readonly isEnabled: boolean;

	/**
	 * Get the current configuration.
	 */
	getConfig(): IOpenTelemetryConfig;

	// ============== Log Events ==============

	/**
	 * Log configuration at session startup.
	 */
	logConfig(attributes: IConfigAttributes): void;

	/**
	 * Log a user prompt submission.
	 */
	logUserPrompt(attributes: IUserPromptAttributes): void;

	/**
	 * Log a tool call event.
	 */
	logToolCall(attributes: IToolCallAttributes): void;

	/**
	 * Log an API request.
	 */
	logApiRequest(attributes: IApiRequestAttributes): void;

	/**
	 * Log an API response.
	 */
	logApiResponse(attributes: IApiResponseAttributes): void;

	/**
	 * Log an API error.
	 */
	logApiError(attributes: IApiResponseAttributes & { error: string; error_type: string }): void;

	/**
	 * Log agent run start.
	 */
	logAgentStart(attributes: Pick<IAgentRunAttributes, 'agent_id' | 'agent_name'>): void;

	/**
	 * Log agent run finish.
	 */
	logAgentFinish(attributes: IAgentRunAttributes): void;

	/**
	 * Log a file operation.
	 */
	logFileOperation(attributes: IFileOperationAttributes): void;

	/**
	 * Log conversation finished.
	 */
	logConversationFinished(attributes: { approvalMode?: string; turnCount: number }): void;

	// ============== Metrics ==============

	/**
	 * Increment session count.
	 */
	incrementSessionCount(): void;

	/**
	 * Record a tool call metric.
	 */
	recordToolCall(functionName: string, success: boolean, toolType: 'native' | 'mcp', durationMs?: number): void;

	/**
	 * Record API request metrics.
	 */
	recordApiRequest(model: string, statusCode: number | string, durationMs: number, errorType?: string): void;

	/**
	 * Record token usage.
	 */
	recordTokenUsage(model: string, tokenType: 'input' | 'output' | 'cache', count: number): void;

	/**
	 * Record file operation metrics.
	 */
	recordFileOperation(operation: 'create' | 'read' | 'update', lines?: number): void;

	/**
	 * Record agent run metrics.
	 */
	recordAgentRun(agentName: string, durationMs: number, turnCount: number, terminateReason: string): void;

	// ============== Spans/Traces ==============

	/**
	 * Start a new span for a chat session.
	 * @returns A span context that should be passed to endSessionSpan.
	 */
	startSessionSpan(sessionId: string): ISpanContext | undefined;

	/**
	 * End a session span.
	 */
	endSessionSpan(spanContext: ISpanContext | undefined): void;

	/**
	 * Start a child span for an API request.
	 */
	startApiRequestSpan(parentContext: ISpanContext | undefined, model: string, requestId: string): ISpanContext | undefined;

	/**
	 * End an API request span.
	 */
	endApiRequestSpan(spanContext: ISpanContext | undefined, success: boolean, tokenUsage?: { input: number; output: number }): void;

	/**
	 * Start a child span for a tool invocation.
	 */
	startToolSpan(parentContext: ISpanContext | undefined, toolName: string): ISpanContext | undefined;

	/**
	 * End a tool span.
	 */
	endToolSpan(spanContext: ISpanContext | undefined, success: boolean, error?: string): void;

	/**
	 * Flush all pending telemetry data.
	 */
	flush(): Promise<void>;
}

/**
 * Represents a span context for distributed tracing.
 */
export interface ISpanContext {
	readonly traceId: string;
	readonly spanId: string;
	/** Internal span reference - implementation specific */
	readonly _span?: unknown;
}

export const IOpenTelemetryService = createServiceIdentifier<IOpenTelemetryService>('IOpenTelemetryService');

/**
 * Default OpenTelemetry configuration.
 */
export const DEFAULT_OTEL_CONFIG: IOpenTelemetryConfig = {
	enabled: false,
	target: 'local',
	otlpEndpoint: 'http://localhost:4317',
	otlpProtocol: 'http',
	logPrompts: false,
};
