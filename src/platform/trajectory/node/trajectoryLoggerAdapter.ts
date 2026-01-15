/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapturingToken } from '../../requestLogger/common/capturingToken';
import { ILoggedToolCall, IRequestLogger, LoggedInfo, LoggedInfoKind, LoggedRequest, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { IAgentInfo, IAgentStepContext, IObservationResult, IStepMetrics, IToolCall } from '../common/trajectoryLogger';
import { ITrajectoryLogger } from '../common/trajectoryLogger';
import { LanguageModelTextPart, LanguageModelDataPart, LanguageModelPromptTsxPart } from '../../../vscodeTypes';
import { renderDataPartToString, renderToolResultToStringNoBudget } from '../../../extension/prompt/vscode-node/requestLoggerToolResult';

/**
 * Adapter that converts request logger entries to trajectory format.
 * This is a bridge between the existing logging system and the new trajectory format.
 */
export class TrajectoryLoggerAdapter {
	private sessionMap = new WeakMap<CapturingToken, string>();
	private processedEntries = new Set<string>();
	private pendingStepContexts = new Map<string, IAgentStepContext>();

	constructor(
		private readonly requestLogger: IRequestLogger,
		private readonly trajectoryLogger: ITrajectoryLogger
	) {
		// Subscribe to request logger updates
		this.requestLogger.onDidChangeRequests(() => {
			this.syncTrajectories();
		});
	}

	/**
	 * Start tracking trajectory for a capturing token context
	 */
	public startTrajectory(token: CapturingToken, agentInfo: IAgentInfo): string {
		const sessionId = this.generateSessionId(token.label);
		this.sessionMap.set(token, sessionId);
		this.trajectoryLogger.startTrajectory(sessionId, agentInfo);
		return sessionId;
	}

	/**
	 * Synchronize trajectories with request logger state
	 */
	private async syncTrajectories(): Promise<void> {
		const requests = this.requestLogger.getRequests();

		for (const entry of requests) {
			// Skip already processed entries
			if (this.processedEntries.has(entry.id)) {
				continue;
			}

			// Only process entries with capturing tokens (grouped requests)
			if (!entry.token) {
				continue;
			}

			// Get or create session for this token
			let sessionId = this.sessionMap.get(entry.token);
			if (!sessionId) {
				// Auto-create session if tracking is enabled
				sessionId = this.generateSessionId(entry.token.label);
				this.sessionMap.set(entry.token, sessionId);
				this.trajectoryLogger.startTrajectory(sessionId, {
					name: entry.token.label,
					version: '1.0.0'
				});
			}

			await this.processEntry(entry, sessionId);
			this.processedEntries.add(entry.id);
		}
	}

	private async processEntry(entry: LoggedInfo, sessionId: string): Promise<void> {
		switch (entry.kind) {
			case LoggedInfoKind.Request:
				await this.processRequestInfo(entry, sessionId);
				break;
			case LoggedInfoKind.ToolCall:
				await this.processToolCall(entry, sessionId);
				break;
			case LoggedInfoKind.Element:
				// Elements are debug info, not relevant for trajectories
				break;
		}
	}

	private async processRequestInfo(entry: LoggedInfo, sessionId: string): Promise<void> {
		if (entry.kind !== LoggedInfoKind.Request) {
			return;
		}

		const loggedRequest = entry.entry;

		// Skip non-conversation requests
		if (loggedRequest.isConversationRequest === false) {
			return;
		}

		// Handle different request types
		if (loggedRequest.type === LoggedRequestKind.ChatMLSuccess) {
			await this.processSuccessfulRequest(loggedRequest, sessionId);
		}
	}

	private async processSuccessfulRequest(request: LoggedRequest & { type: LoggedRequestKind.ChatMLSuccess }, sessionId: string): Promise<void> {
		const message = Array.isArray(request.result.value) 
			? request.result.value.join('\n') 
			: String(request.result.value);

		const modelName = request.chatEndpoint.model;
		
		// Extract reasoning content from deltas if available
		let reasoningContent: string | undefined;
		if (request.deltas) {
			const thinkingDeltas = request.deltas.filter(d => d.thinking);
			if (thinkingDeltas.length > 0) {
				reasoningContent = thinkingDeltas.map(d => d.thinking?.text || '').join('\n');
			}
		}

		const stepContext = this.trajectoryLogger.beginAgentStep(
			message,
			modelName,
			reasoningContent,
			request.startTime.toISOString()
		);

		// Add metrics
		if (request.usage) {
			const metrics: IStepMetrics = {
				prompt_tokens: request.usage.prompt_tokens,
				completion_tokens: request.usage.completion_tokens,
				cached_tokens: request.usage.prompt_tokens_details?.cached_tokens,
				time_to_first_token_ms: request.timeToFirstToken,
				duration_ms: request.endTime.getTime() - request.startTime.getTime()
			};
			stepContext.setMetrics(metrics);
		}

		// Store pending context for tool calls to attach to
		this.pendingStepContexts.set(sessionId, stepContext);

		// If no tool calls expected, complete immediately
		// Otherwise, tool calls will complete it
		if (!request.deltas?.some(d => d.copilotToolCalls)) {
			stepContext.complete();
			this.pendingStepContexts.delete(sessionId);
		}
	}

	private async processToolCall(entry: ILoggedToolCall, sessionId: string): Promise<void> {
		// Get pending step context if exists
		let stepContext = this.pendingStepContexts.get(sessionId);
		
		if (!stepContext) {
			// Create a new step for this tool call
			stepContext = this.trajectoryLogger.beginAgentStep('', undefined, 
				entry.thinking?.text ? (Array.isArray(entry.thinking.text) ? entry.thinking.text.join('\n') : entry.thinking.text) : undefined);
		}

		// Parse tool call
		const toolCall: IToolCall = {
			tool_call_id: entry.id,
			function_name: entry.name,
			arguments: this.parseArguments(entry.args)
		};

		stepContext.addToolCalls([toolCall]);

		// Extract observation result
		const content = await this.extractToolResultContent(entry);
		const observationResult: IObservationResult = {
			source_call_id: entry.id,
			content
		};

		// Check if this is a subagent tool call
		const toolMetadata = (entry as any).toolMetadata;
		if (toolMetadata && entry.name === 'search_subagent') {
			// This is a subagent invocation - add subagent reference
			// The subagent's own trajectory should be registered separately
			stepContext.addSubagentReference(entry.id, {
				session_id: `subagent-${entry.id}`,
				extra: toolMetadata
			});
		}

		stepContext.addObservation([observationResult]);
		stepContext.complete();
		this.pendingStepContexts.delete(sessionId);
	}

	private parseArguments(args: unknown): Record<string, unknown> {
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

	private async extractToolResultContent(entry: ILoggedToolCall): Promise<string> {
		const parts: string[] = [];

		for (const content of entry.response.content) {
			if (content instanceof LanguageModelTextPart) {
				parts.push(content.value);
			} else if (content instanceof LanguageModelDataPart) {
				parts.push(renderDataPartToString(content));
			} else if (content instanceof LanguageModelPromptTsxPart) {
				parts.push(await renderToolResultToStringNoBudget(content));
			}
		}

		return parts.join('\n');
	}

	private generateSessionId(label: string): string {
		const sanitized = label.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return `${sanitized}-${Date.now()}`;
	}

	/**
	 * Get all tracked trajectories
	 */
	public getAllTrajectories() {
		return this.trajectoryLogger.getAllTrajectories();
	}
}
