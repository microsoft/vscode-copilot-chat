/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	DEFAULT_OTEL_CONFIG,
	IAgentRunAttributes,
	IApiRequestAttributes,
	IApiResponseAttributes,
	IConfigAttributes,
	IFileOperationAttributes,
	IOpenTelemetryConfig,
	IOpenTelemetryService,
	ISpanContext,
	IToolCallAttributes,
	IUserPromptAttributes,
} from './openTelemetryService';

/**
 * A no-op implementation of the OpenTelemetry service.
 * Used when OpenTelemetry instrumentation is disabled.
 */
export class NullOpenTelemetryService implements IOpenTelemetryService {
	declare readonly _serviceBrand: undefined;

	readonly isEnabled = false;

	getConfig(): IOpenTelemetryConfig {
		return DEFAULT_OTEL_CONFIG;
	}

	// Log Events - all no-ops
	logConfig(_attributes: IConfigAttributes): void { }
	logUserPrompt(_attributes: IUserPromptAttributes): void { }
	logToolCall(_attributes: IToolCallAttributes): void { }
	logApiRequest(_attributes: IApiRequestAttributes): void { }
	logApiResponse(_attributes: IApiResponseAttributes): void { }
	logApiError(_attributes: IApiResponseAttributes & { error: string; error_type: string }): void { }
	logAgentStart(_attributes: Pick<IAgentRunAttributes, 'agent_id' | 'agent_name'>): void { }
	logAgentFinish(_attributes: IAgentRunAttributes): void { }
	logFileOperation(_attributes: IFileOperationAttributes): void { }
	logConversationFinished(_attributes: { approvalMode?: string; turnCount: number }): void { }

	// Metrics - all no-ops
	incrementSessionCount(): void { }
	recordToolCall(_functionName: string, _success: boolean, _toolType: 'native' | 'mcp', _durationMs?: number): void { }
	recordApiRequest(_model: string, _statusCode: number | string, _durationMs: number, _errorType?: string): void { }
	recordTokenUsage(_model: string, _tokenType: 'input' | 'output' | 'cache', _count: number): void { }
	recordFileOperation(_operation: 'create' | 'read' | 'update', _lines?: number): void { }
	recordAgentRun(_agentName: string, _durationMs: number, _turnCount: number, _terminateReason: string): void { }

	// Spans - all return undefined
	startSessionSpan(_sessionId: string): ISpanContext | undefined { return undefined; }
	endSessionSpan(_spanContext: ISpanContext | undefined): void { }
	startApiRequestSpan(_parentContext: ISpanContext | undefined, _model: string, _requestId: string): ISpanContext | undefined { return undefined; }
	endApiRequestSpan(_spanContext: ISpanContext | undefined, _success: boolean, _tokenUsage?: { input: number; output: number }): void { }
	startToolSpan(_parentContext: ISpanContext | undefined, _toolName: string): ISpanContext | undefined { return undefined; }
	endToolSpan(_spanContext: ISpanContext | undefined, _success: boolean, _error?: string): void { }

	async flush(): Promise<void> { }
	dispose(): void { }
}
