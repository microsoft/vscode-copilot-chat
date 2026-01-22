/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart } from '../../../vscodeTypes';
import { CapturingToken } from '../../requestLogger/common/capturingToken';
import { ILoggedToolCall, IRequestLogger, LoggedInfo, LoggedInfoKind, LoggedRequest, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { IAgentInfo, IAgentStepContext, IObservationResult, IStepMetrics, IToolCall, ITrajectoryLogger } from '../common/trajectoryLogger';

/**
 * Adapter that converts request logger entries to trajectory format.
 * This is a bridge between the existing logging system and the new trajectory format.
 */
export class TrajectoryLoggerAdapter extends Disposable {
	private sessionMap = new WeakMap<CapturingToken, string>();
	private processedEntries = new Set<string>();
	private processedToolCalls = new Set<string>(); // Track processed tool calls by their ID
	private lastUserMessageBySession = new Map<string, string>();
	// Track pending step contexts by both session and request ID to handle parallel tool calls
	private pendingStepContexts = new Map<string, IAgentStepContext>();
	private requestToStepContext = new Map<string, { sessionId: string; context: IAgentStepContext; toolCallCount: number; processedToolCalls: number }>();

	constructor(
		private readonly requestLogger: IRequestLogger,
		private readonly trajectoryLogger: ITrajectoryLogger
	) {
		super();
		// Subscribe to request logger updates
		this._register(this.requestLogger.onDidChangeRequests(() => {
			this.syncTrajectories();
		}));
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
					name: this.extractAgentName(entry.token.label),
					version: '1.0.0'
				});
			}

			// Switch active session before processing the entry. This avoids the
			// "last started wins" behavior where subagent sessions overwrite main.
			this.trajectoryLogger.startTrajectory(sessionId, {
				name: this.extractAgentName(entry.token.label),
				version: '1.0.0'
			});

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
		this.maybeAddUserStepFromRequest(request, sessionId);

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

		// Count expected tool calls from this request
		let toolCallCount = 0;
		if (request.deltas) {
			for (const delta of request.deltas) {
				if (delta.copilotToolCalls) {
					toolCallCount += delta.copilotToolCalls.length;
				}
			}
		}

		// If no tool calls expected, complete immediately
		if (toolCallCount === 0) {
			stepContext.complete();
		} else {
			// Store context with request ID for tool calls to attach to
			// Use a unique request ID based on startTime
			const requestId = `${sessionId}-${request.startTime.getTime()}`;
			this.requestToStepContext.set(requestId, {
				sessionId,
				context: stepContext,
				toolCallCount,
				processedToolCalls: 0
			});
			// Also store in pendingStepContexts for backwards compatibility
			this.pendingStepContexts.set(sessionId, stepContext);
		}
	}

	private maybeAddUserStepFromRequest(request: LoggedRequest & { startTime: Date }, sessionId: string): void {
		const messages = this.getChatMessagesFromRequest(request);
		if (!Array.isArray(messages) || messages.length === 0) {
			return;
		}

		const lastUser = this.getLastUserMessageText(messages);
		if (!lastUser) {
			return;
		}

		const lastKey = this.lastUserMessageBySession.get(sessionId);
		const key = this.simpleHash(lastUser) + ':' + lastUser.length;
		if (lastKey === key) {
			return;
		}

		this.lastUserMessageBySession.set(sessionId, key);
		const timestamp = request.startTime.toISOString();
		this.trajectoryLogger.addUserStep(lastUser, timestamp);
	}

	private getChatMessagesFromRequest(request: LoggedRequest): Raw.ChatMessage[] | undefined {
		const messages = (request as unknown as { chatParams?: { messages?: unknown } }).chatParams?.messages;
		if (!Array.isArray(messages)) {
			return undefined;
		}
		return messages as Raw.ChatMessage[];
	}

	private getLastUserMessageText(messages: Raw.ChatMessage[]): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== Raw.ChatRole.User) {
				continue;
			}

			const content = (m as unknown as { content?: unknown }).content;
			if (typeof content === 'string') {
				return content.trim() || undefined;
			}

			if (!Array.isArray(content)) {
				return undefined;
			}

			const text = content
				.map(part => {
					const partType = (part as { type?: unknown }).type;
					if (partType === Raw.ChatCompletionContentPartKind.Text) {
						const t = (part as { text?: unknown }).text;
						return typeof t === 'string' ? t : undefined;
					}
					return undefined;
				})
				.filter((t): t is string => typeof t === 'string' && t.length > 0)
				.join('\n')
				.trim();

			return text || undefined;
		}
		return undefined;
	}

	private async processToolCall(entry: ILoggedToolCall, sessionId: string): Promise<void> {
		// Skip already processed tool calls (prevents duplicates from multiple event fires)
		if (this.processedToolCalls.has(entry.id)) {
			return;
		}
		this.processedToolCalls.add(entry.id);

		// Find the step context for this tool call
		// Try to find by iterating request contexts for this session
		let stepInfo: { sessionId: string; context: IAgentStepContext; toolCallCount: number; processedToolCalls: number } | undefined;
		let requestKey: string | undefined;

		for (const [key, info] of this.requestToStepContext) {
			if (info.sessionId === sessionId) {
				stepInfo = info;
				requestKey = key;
				break;
			}
		}

		let stepContext: IAgentStepContext;
		let shouldComplete = true;

		if (stepInfo) {
			stepContext = stepInfo.context;
			stepInfo.processedToolCalls++;
			// Only complete after all tool calls are processed
			shouldComplete = stepInfo.processedToolCalls >= stepInfo.toolCallCount;
		} else {
			// No pending context - create a new step for this orphan tool call
			stepContext = this.trajectoryLogger.beginAgentStep('', undefined,
				entry.thinking?.text ? (Array.isArray(entry.thinking.text) ? entry.thinking.text.join('\n') : entry.thinking.text) : undefined);
		}

		// Parse tool call
		const toolCall: IToolCall = {
			tool_call_id: entry.id,
			function_name: entry.name,
			arguments: this.parseArguments(entry.args),
			execution_mode: stepInfo && stepInfo.toolCallCount > 1 ? 'parallel' : undefined
		};

		stepContext.addToolCalls([toolCall]);

		// Extract observation result
		const content = await this.extractToolResultContent(entry);
		const observationResult: IObservationResult = {
			source_call_id: entry.id,
			content
		};

		// Add observation first so subagent references merge into the same result.
		stepContext.addObservation([observationResult]);

		// Check if this is a subagent tool call (runSubagent)
		if (entry.name === 'runSubagent') {
			// This is a subagent invocation - add subagent reference
			stepContext.addSubagentReference(entry.id, {
				session_id: `subagent-${entry.id}`
			});
		}

		// Only complete when all tool calls from this request are processed
		if (shouldComplete) {
			stepContext.complete();
			if (requestKey) {
				this.requestToStepContext.delete(requestKey);
			}
			this.pendingStepContexts.delete(sessionId);
		}
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
				parts.push(this.renderDataPartToString(content));
			} else if (content instanceof LanguageModelPromptTsxPart) {
				parts.push(this.renderPromptTsxPartToStringNoBudget(content));
			}
		}

		return parts.join('\n');
	}

	private renderPromptTsxPartToStringNoBudget(part: LanguageModelPromptTsxPart): string {
		// Best-effort: keep the structured payload for later inspection without
		// depending on extension-layer prompt rendering helpers.
		try {
			return JSON.stringify(part.value, null, 2);
		} catch {
			return String(part.value);
		}
	}

	private renderDataPartToString(part: LanguageModelDataPart): string {
		const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
		const isImage = mimeType.startsWith('image/');

		if (isImage) {
			const base64 = Buffer.from(part.data).toString('base64');
			return `data:${mimeType};base64,${base64}`;
		}

		try {
			return new TextDecoder().decode(part.data);
		} catch {
			return `<decode error: ${part.data.length} bytes>`;
		}
	}

	private generateSessionId(label: string): string {
		// Create a short hash from the label for uniqueness
		const hash = this.simpleHash(label);
		// Truncate and sanitize the label to create a readable prefix
		const sanitized = label.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.substring(0, 30); // Limit to 30 chars for readability
		return `${sanitized}-${hash}-${Date.now()}`;
	}

	private simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * Extract a meaningful agent name from a label or prompt.
	 * For subagent prompts, extract the description or first meaningful line.
	 */
	private extractAgentName(label: string): string {
		const normalizedLabel = label.trim().replace(/\s+/g, ' ');
		// If it looks like a subagent prompt (starts with "You are" or similar)
		if (normalizedLabel.startsWith('You are editing') || normalizedLabel.startsWith('You are ')) {
			// Try to extract a meaningful name from the first line or task description
			const firstLine = normalizedLabel.split('\n')[0];
			if (firstLine.length > 80) {
				return 'subagent-task';
			}
			return firstLine.substring(0, 80);
		}
		// If it's a short label, use it directly
		if (normalizedLabel.length <= 80) {
			return normalizedLabel;
		}
		// Otherwise truncate
		return normalizedLabel.substring(0, 77) + '...';
	}

	/**
	 * Get all tracked trajectories
	 */
	public getAllTrajectories() {
		return this.trajectoryLogger.getAllTrajectories();
	}
}
