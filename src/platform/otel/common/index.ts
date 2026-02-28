/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export { CopilotChatAttr, GenAiAttr, GenAiOperationName, GenAiProviderName, GenAiTokenType, GenAiToolType, StdAttr } from './genAiAttributes';
export { emitAgentTurnEvent, emitInferenceDetailsEvent, emitSessionStartEvent, emitToolCallEvent } from './genAiEvents';
export { GenAiMetrics } from './genAiMetrics';
export { toInputMessages, toOutputMessages, toSystemInstructions, toToolDefinitions, truncateForOTel } from './messageFormatters';
export { NoopOTelService } from './noopOtelService';
export { resolveOTelConfig, type OTelConfig, type OTelConfigInput } from './otelConfig';
export { IOTelService, SpanKind, SpanStatusCode, type ISpanHandle, type SpanOptions, type TraceContext } from './otelService';

