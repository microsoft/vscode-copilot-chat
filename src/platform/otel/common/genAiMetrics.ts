/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GenAiAttr, StdAttr } from './genAiAttributes';
import type { IOTelService } from './otelService';

/**
 * Pre-configured OTel GenAI metric instruments.
 * All methods are static to avoid per-call allocations (aligned with gemini-cli pattern).
 */
export class GenAiMetrics {

	// ── GenAI Convention Metrics ──

	static recordOperationDuration(
		otel: IOTelService,
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
		otel.recordMetric('gen_ai.client.operation.duration', durationSec, {
			[GenAiAttr.OPERATION_NAME]: attrs.operationName,
			[GenAiAttr.PROVIDER_NAME]: attrs.providerName,
			[GenAiAttr.REQUEST_MODEL]: attrs.requestModel,
			...(attrs.responseModel ? { [GenAiAttr.RESPONSE_MODEL]: attrs.responseModel } : {}),
			...(attrs.serverAddress ? { [StdAttr.SERVER_ADDRESS]: attrs.serverAddress } : {}),
			...(attrs.serverPort ? { [StdAttr.SERVER_PORT]: attrs.serverPort } : {}),
			...(attrs.errorType ? { [StdAttr.ERROR_TYPE]: attrs.errorType } : {}),
		});
	}

	static recordTokenUsage(
		otel: IOTelService,
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
		otel.recordMetric('gen_ai.client.token.usage', tokenCount, {
			[GenAiAttr.OPERATION_NAME]: attrs.operationName,
			[GenAiAttr.PROVIDER_NAME]: attrs.providerName,
			[GenAiAttr.TOKEN_TYPE]: tokenType,
			[GenAiAttr.REQUEST_MODEL]: attrs.requestModel,
			...(attrs.responseModel ? { [GenAiAttr.RESPONSE_MODEL]: attrs.responseModel } : {}),
			...(attrs.serverAddress ? { [StdAttr.SERVER_ADDRESS]: attrs.serverAddress } : {}),
		});
	}

	// ── Extension-Specific Metrics ──

	static recordToolCallCount(otel: IOTelService, toolName: string, success: boolean): void {
		otel.incrementCounter('copilot_chat.tool.call.count', 1, {
			[GenAiAttr.TOOL_NAME]: toolName,
			success,
		});
	}

	static recordToolCallDuration(otel: IOTelService, toolName: string, durationMs: number): void {
		otel.recordMetric('copilot_chat.tool.call.duration', durationMs, {
			[GenAiAttr.TOOL_NAME]: toolName,
		});
	}

	static recordAgentDuration(otel: IOTelService, agentName: string, durationSec: number): void {
		otel.recordMetric('copilot_chat.agent.invocation.duration', durationSec, {
			[GenAiAttr.AGENT_NAME]: agentName,
		});
	}

	static recordAgentTurnCount(otel: IOTelService, agentName: string, turnCount: number): void {
		otel.recordMetric('copilot_chat.agent.turn.count', turnCount, {
			[GenAiAttr.AGENT_NAME]: agentName,
		});
	}

	static recordTimeToFirstToken(otel: IOTelService, model: string, ttftSec: number): void {
		otel.recordMetric('copilot_chat.time_to_first_token', ttftSec, {
			[GenAiAttr.REQUEST_MODEL]: model,
		});
	}

	static incrementSessionCount(otel: IOTelService): void {
		otel.incrementCounter('copilot_chat.session.count');
	}
}
