/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GenAiAttr, StdAttr } from './genAiAttributes';
import type { IOTelService } from './otelService';

/**
 * Pre-configured OTel GenAI metric instruments.
 * Uses the IOTelService abstraction — no direct OTel SDK dependency.
 */
export class GenAiMetrics {
	constructor(private readonly _otel: IOTelService) { }

	// ── GenAI Convention Metrics ──

	recordOperationDuration(
		durationSec: number,
		attrs: {
			operationName: string;
			providerName: string;
			requestModel: string;
			responseModel?: string;
			serverAddress?: string;
			serverPort?: number;
			errorType?: string;
		},
	): void {
		this._otel.recordMetric('gen_ai.client.operation.duration', durationSec, {
			[GenAiAttr.OPERATION_NAME]: attrs.operationName,
			[GenAiAttr.PROVIDER_NAME]: attrs.providerName,
			[GenAiAttr.REQUEST_MODEL]: attrs.requestModel,
			...(attrs.responseModel ? { [GenAiAttr.RESPONSE_MODEL]: attrs.responseModel } : {}),
			...(attrs.serverAddress ? { [StdAttr.SERVER_ADDRESS]: attrs.serverAddress } : {}),
			...(attrs.serverPort ? { [StdAttr.SERVER_PORT]: attrs.serverPort } : {}),
			...(attrs.errorType ? { [StdAttr.ERROR_TYPE]: attrs.errorType } : {}),
		});
	}

	recordTokenUsage(
		tokenCount: number,
		tokenType: 'input' | 'output',
		attrs: {
			operationName: string;
			providerName: string;
			requestModel: string;
			responseModel?: string;
			serverAddress?: string;
		},
	): void {
		this._otel.recordMetric('gen_ai.client.token.usage', tokenCount, {
			[GenAiAttr.OPERATION_NAME]: attrs.operationName,
			[GenAiAttr.PROVIDER_NAME]: attrs.providerName,
			[GenAiAttr.TOKEN_TYPE]: tokenType,
			[GenAiAttr.REQUEST_MODEL]: attrs.requestModel,
			...(attrs.responseModel ? { [GenAiAttr.RESPONSE_MODEL]: attrs.responseModel } : {}),
			...(attrs.serverAddress ? { [StdAttr.SERVER_ADDRESS]: attrs.serverAddress } : {}),
		});
	}

	// ── Extension-Specific Metrics ──

	recordToolCallCount(toolName: string, success: boolean): void {
		this._otel.incrementCounter('copilot_chat.tool.call.count', 1, {
			[GenAiAttr.TOOL_NAME]: toolName,
			success,
		});
	}

	recordToolCallDuration(toolName: string, durationMs: number): void {
		this._otel.recordMetric('copilot_chat.tool.call.duration', durationMs, {
			[GenAiAttr.TOOL_NAME]: toolName,
		});
	}

	recordAgentDuration(agentName: string, durationSec: number): void {
		this._otel.recordMetric('copilot_chat.agent.invocation.duration', durationSec, {
			[GenAiAttr.AGENT_NAME]: agentName,
		});
	}

	recordAgentTurnCount(agentName: string, turnCount: number): void {
		this._otel.recordMetric('copilot_chat.agent.turn.count', turnCount, {
			[GenAiAttr.AGENT_NAME]: agentName,
		});
	}

	recordTimeToFirstToken(model: string, ttftSec: number): void {
		this._otel.recordMetric('copilot_chat.time_to_first_token', ttftSec, {
			[GenAiAttr.REQUEST_MODEL]: model,
		});
	}

	incrementSessionCount(): void {
		this._otel.incrementCounter('copilot_chat.session.count');
	}
}
