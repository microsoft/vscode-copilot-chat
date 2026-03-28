/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';

export interface IToolCallMetric {
	name: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	tokensUsed?: number;
	status: 'pending' | 'success' | 'error';
	errorMessage?: string;
}

export interface IExecutionMetrics {
	sessionId: string;
	startTime: number;
	endTime?: number;
	totalDuration?: number;
	toolCalls: IToolCallMetric[];
	totalToolCalls: number;
	successfulToolCalls: number;
	failedToolCalls: number;
	estimatedTokensUsed: number;
	estimatedApiCostUSD?: number;
}

export const IExecutionMetricsService = createServiceIdentifier<IExecutionMetricsService>('IExecutionMetricsService');

/**
 * Service for tracking agent execution metrics including tool calls, duration, and resource usage.
 */
export interface IExecutionMetricsService extends IDisposable {
	/**
	 * Start tracking a new execution session
	 */
	startSession(sessionId: string): void;

	/**
	 * End the current execution session and return metrics
	 */
	endSession(sessionId: string): IExecutionMetrics | undefined;

	/**
	 * Record that a tool call started
	 */
	recordToolCallStart(sessionId: string, toolName: string): string;

	/**
	 * Record that a tool call completed
	 */
	recordToolCallEnd(sessionId: string, callId: string, status: 'success' | 'error', tokensUsed?: number, errorMessage?: string): void;

	/**
	 * Get current metrics for an active session
	 */
	getMetrics(sessionId: string): IExecutionMetrics | undefined;

	/**
	 * Get estimated cost based on tokens
	 */
	estimateCost(tokensUsed: number, model?: string): number;
}

/**
 * Default implementation of IExecutionMetricsService
 */
export class ExecutionMetricsService implements IExecutionMetricsService {
	declare readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, {
		metrics: IExecutionMetrics;
		callIdCounter: number;
	}>();

	// Pricing per token (input tokens typically cheaper than output tokens).
	// Using rough estimates for GPT-4 Turbo pricing.
	private readonly tokenPricingPerMillionTokens = {
		'input': 0.01, // $0.01 per 1K input tokens
		'output': 0.03, // $0.03 per 1K output tokens
		'default': 0.02  // Average estimate
	};

	startSession(sessionId: string): void {
		if (this.sessions.has(sessionId)) {
			return; // Session already exists
		}

		const now = Date.now();
		this.sessions.set(sessionId, {
			metrics: {
				sessionId,
				startTime: now,
				toolCalls: [],
				totalToolCalls: 0,
				successfulToolCalls: 0,
				failedToolCalls: 0,
				estimatedTokensUsed: 0,
			},
			callIdCounter: 0
		});
	}

	endSession(sessionId: string): IExecutionMetrics | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return undefined;
		}

		const now = Date.now();
		const metrics = session.metrics;
		metrics.endTime = now;
		metrics.totalDuration = now - metrics.startTime;

		// Calculate estimated cost
		if (metrics.estimatedTokensUsed > 0) {
			const pricePerToken = this.tokenPricingPerMillionTokens.default / 1_000_000;
			metrics.estimatedApiCostUSD = metrics.estimatedTokensUsed * pricePerToken;
		}

		this.sessions.delete(sessionId);
		return metrics;
	}

	recordToolCallStart(sessionId: string, toolName: string): string {
		const session = this.sessions.get(sessionId);
		if (!session) {
			this.startSession(sessionId);
			return this.recordToolCallStart(sessionId, toolName);
		}

		const callId = `${toolName}-${++session.callIdCounter}`;
		const toolCall: IToolCallMetric = {
			name: toolName,
			startTime: Date.now(),
			status: 'pending'
		};

		session.metrics.toolCalls.push(toolCall);
		session.metrics.totalToolCalls++;

		return callId;
	}

	recordToolCallEnd(sessionId: string, callId: string, status: 'success' | 'error', tokensUsed?: number, errorMessage?: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const now = Date.now();
		const toolCall = session.metrics.toolCalls.find(tc => `${tc.name}-${session.callIdCounter}` === callId);

		if (toolCall) {
			toolCall.endTime = now;
			toolCall.duration = now - toolCall.startTime;
			toolCall.status = status;
			toolCall.tokensUsed = tokensUsed;
			toolCall.errorMessage = errorMessage;

			if (status === 'success') {
				session.metrics.successfulToolCalls++;
			} else {
				session.metrics.failedToolCalls++;
			}

			if (tokensUsed) {
				session.metrics.estimatedTokensUsed += tokensUsed;
			}
		}
	}

	getMetrics(sessionId: string): IExecutionMetrics | undefined {
		const session = this.sessions.get(sessionId);
		return session?.metrics;
	}

	estimateCost(tokensUsed: number, _model?: string): number {
		const pricePerToken = this.tokenPricingPerMillionTokens.default / 1_000_000;
		return tokensUsed * pricePerToken;
	}

	dispose(): void {
		this.sessions.clear();
	}
}
