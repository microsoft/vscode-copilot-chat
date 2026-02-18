/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export { CopilotAttr, GenAiAttr, GenAiOperationName, GenAiProviderName, GenAiTokenType, GenAiToolType, StdAttr } from './common/genAiAttributes';
export { emitAgentTurnEvent, emitInferenceDetailsEvent, emitSessionStartEvent, emitToolCallEvent } from './common/genAiEvents';
export { GenAiMetrics } from './common/genAiMetrics';
export { toInputMessages, toOutputMessages, toSystemInstructions, toToolDefinitions } from './common/messageFormatters';
export { NoopOTelService } from './common/noopOtelService';
export { resolveOTelConfig, type OTelConfig, type OTelConfigInput } from './common/otelConfig';
export { IOTelService, SpanKind, SpanStatusCode, type ISpanHandle, type SpanOptions } from './common/otelService';

