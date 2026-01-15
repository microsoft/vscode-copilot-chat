/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelTextPart } from '../../../vscodeTypes';
import { CapturingToken } from '../../requestLogger/common/capturingToken';
import { ILoggedToolCall, IRequestLogger, LoggedInfo, LoggedInfoKind, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { IAgentInfo, IObservationResult, IStepMetrics, IToolCall } from '../common/trajectoryLogger';
import { ITrajectoryLogger } from '../common/trajectoryLogger';

/**
 * Integrates the trajectory logger with the existing request logger.
 * Listens to request logger events and builds trajectory data.
 */
export class TrajectoryLoggerIntegration {
	private sessionIdStack: string[] = [];
	private capturingTokenMap = new WeakMap<CapturingToken, string>();

	constructor(
		private readonly requestLogger: IRequestLogger,
		private readonly trajectoryLogger: ITrajectoryLogger
	) {
		// Listen to request logger changes and build trajectory
		this.requestLogger.onDidChangeRequests(() => {
			this.processRequestLogs();
		});
	}

	/**
	 * Start tracking a new trajectory for the given capturing token
	 */
	public startTrajectoryForToken(token: CapturingToken, agentInfo: IAgentInfo): string {
		// Generate session ID based on token label and timestamp
		const sessionId = `${this.sanitizeSessionId(token.label)}-${Date.now()}`;
		this.capturingTokenMap.set(token, sessionId);
		this.trajectoryLogger.startTrajectory(sessionId, agentInfo);
		this.sessionIdStack.push(sessionId);
		return sessionId;
	}

	/**
	 * Process request logs and update trajectory
	 */
	private processRequestLogs(): void {
		const requests = this.requestLogger.getRequests();
		
		// Process in chronological order
		for (const logEntry of requests) {
			this.processLogEntry(logEntry);
		}
	}

	private processLogEntry(logEntry: LoggedInfo): void {
		switch (logEntry.kind) {
			case LoggedInfoKind.Request:
				this.processRequestEntry(logEntry);
				break;
			case LoggedInfoKind.ToolCall:
				this.processToolCallEntry(logEntry);
				break;
			case LoggedInfoKind.Element:
				// Element info is mostly for debugging, not needed in trajectory
				break;
		}
	}

	private processRequestEntry(logEntry: LoggedInfo): void {
		if (logEntry.kind !== LoggedInfoKind.Request) {
			return;
		}

		const entry = logEntry.entry;

		// Skip non-conversation requests
		if (entry.isConversationRequest === false) {
			return;
		}

		// Get session ID from capturing token
		const sessionId = logEntry.token ? this.capturingTokenMap.get(logEntry.token) : undefined;
		if (!sessionId) {
			return; // Not tracking this session
		}

		// Only process successful requests for now
		if (entry.type === LoggedRequestKind.ChatMLSuccess) {
			const modelName = entry.chatEndpoint.model;
			const message = Array.isArray(entry.result.value) ? entry.result.value.join('\n') : entry.result.value.toString();

			// Create an agent step
			const stepContext = this.trajectoryLogger.beginAgentStep(message, modelName);

			// Add metrics if available
			if (entry.usage) {
				const metrics: IStepMetrics = {
					prompt_tokens: entry.usage.prompt_tokens,
					completion_tokens: entry.usage.completion_tokens,
					cached_tokens: entry.usage.prompt_tokens_details?.cached_tokens,
					time_to_first_token_ms: entry.timeToFirstToken,
					duration_ms: entry.endTime.getTime() - entry.startTime.getTime()
				};
				stepContext.setMetrics(metrics);
			}

			stepContext.complete();
		}
	}

	private processToolCallEntry(logEntry: ILoggedToolCall): void {
		// Get session ID from capturing token
		const sessionId = logEntry.token ? this.capturingTokenMap.get(logEntry.token) : undefined;
		if (!sessionId) {
			return; // Not tracking this session
		}

		// Extract tool call information
		const toolCall: IToolCall = {
			tool_call_id: logEntry.id,
			function_name: logEntry.name,
			arguments: this.parseToolArguments(logEntry.args)
		};

		// Extract observation result
		const observationResult: IObservationResult = {
			source_call_id: logEntry.id,
			content: this.extractToolResultContent(logEntry)
		};

		// Create agent step with tool call and observation
		const stepContext = this.trajectoryLogger.beginAgentStep('', undefined, logEntry.thinking?.text as string | undefined);
		stepContext.addToolCalls([toolCall]);
		stepContext.addObservation([observationResult]);
		stepContext.complete();
	}

	private parseToolArguments(args: unknown): Record<string, unknown> {
		if (typeof args === 'string') {
			try {
				return JSON.parse(args) as Record<string, unknown>;
			} catch {
				return { raw: args };
			}
		}
		if (typeof args === 'object' && args !== null) {
			return args as Record<string, unknown>;
		}
		return {};
	}

	private extractToolResultContent(logEntry: ILoggedToolCall): string {
		const parts = logEntry.response.content;
		const textParts: string[] = [];

		for (const part of parts) {
			if (part instanceof LanguageModelTextPart) {
				textParts.push(part.value);
			}
		}

		return textParts.join('\n');
	}

	private sanitizeSessionId(label: string): string {
		// Remove non-alphanumeric characters and replace spaces with dashes
		return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	}

	/**
	 * End tracking for the current session
	 */
	public endCurrentSession(): void {
		this.sessionIdStack.pop();
	}
}
