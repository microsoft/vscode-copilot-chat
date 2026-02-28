/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GenAiAttr, GenAiOperationName, StdAttr } from './genAiAttributes';
import { truncateForOTel } from './messageFormatters';
import type { IOTelService } from './otelService';

/**
 * Emit OTel GenAI standard events via the IOTelService abstraction.
 */
export function emitInferenceDetailsEvent(
	otel: IOTelService,
	request: {
		model: string;
		temperature?: number;
		maxTokens?: number;
		messages?: unknown;
		systemMessage?: unknown;
		tools?: unknown;
	},
	response: {
		id?: string;
		model?: string;
		finishReasons?: string[];
		inputTokens?: number;
		outputTokens?: number;
	} | undefined,
	error?: { type: string; message: string },
): void {
	const attributes: Record<string, unknown> = {
		'event.name': 'gen_ai.client.inference.operation.details',
		[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
		[GenAiAttr.REQUEST_MODEL]: request.model,
	};

	if (response) {
		if (response.model) { attributes[GenAiAttr.RESPONSE_MODEL] = response.model; }
		if (response.id) { attributes[GenAiAttr.RESPONSE_ID] = response.id; }
		if (response.finishReasons) { attributes[GenAiAttr.RESPONSE_FINISH_REASONS] = response.finishReasons; }
		if (response.inputTokens !== undefined) { attributes[GenAiAttr.USAGE_INPUT_TOKENS] = response.inputTokens; }
		if (response.outputTokens !== undefined) { attributes[GenAiAttr.USAGE_OUTPUT_TOKENS] = response.outputTokens; }
	}

	if (request.temperature !== undefined) { attributes[GenAiAttr.REQUEST_TEMPERATURE] = request.temperature; }
	if (request.maxTokens !== undefined) { attributes[GenAiAttr.REQUEST_MAX_TOKENS] = request.maxTokens; }

	if (error) {
		attributes[StdAttr.ERROR_TYPE] = error.type;
	}

	// Full content capture with truncation to prevent OTLP batch failures
	if (otel.config.captureContent) {
		if (request.messages !== undefined) {
			attributes[GenAiAttr.INPUT_MESSAGES] = truncateForOTel(JSON.stringify(request.messages));
		}
		if (request.systemMessage !== undefined) {
			attributes[GenAiAttr.SYSTEM_INSTRUCTIONS] = truncateForOTel(JSON.stringify(request.systemMessage));
		}
		if (request.tools !== undefined) {
			attributes[GenAiAttr.TOOL_DEFINITIONS] = truncateForOTel(JSON.stringify(request.tools));
		}
	}

	otel.emitLogRecord(`GenAI inference: ${request.model}`, attributes);
}

/**
 * Emit extension-specific events.
 */
export function emitSessionStartEvent(
	otel: IOTelService,
	sessionId: string,
	model: string,
	participant: string,
): void {
	otel.emitLogRecord('copilot_chat.session.start', {
		'event.name': 'copilot_chat.session.start',
		'session.id': sessionId,
		[GenAiAttr.REQUEST_MODEL]: model,
		[GenAiAttr.AGENT_NAME]: participant,
	});
}

export function emitToolCallEvent(
	otel: IOTelService,
	toolName: string,
	durationMs: number,
	success: boolean,
	error?: string,
): void {
	otel.emitLogRecord(`copilot_chat.tool.call: ${toolName}`, {
		'event.name': 'copilot_chat.tool.call',
		[GenAiAttr.TOOL_NAME]: toolName,
		'duration_ms': durationMs,
		'success': success,
		...(error ? { [StdAttr.ERROR_TYPE]: error } : {}),
	});
}

export function emitAgentTurnEvent(
	otel: IOTelService,
	turnIndex: number,
	inputTokens: number,
	outputTokens: number,
	toolCallCount: number,
): void {
	otel.emitLogRecord(`copilot_chat.agent.turn: ${turnIndex}`, {
		'event.name': 'copilot_chat.agent.turn',
		'turn.index': turnIndex,
		[GenAiAttr.USAGE_INPUT_TOKENS]: inputTokens,
		[GenAiAttr.USAGE_OUTPUT_TOKENS]: outputTokens,
		'tool_call_count': toolCallCount,
	});
}
