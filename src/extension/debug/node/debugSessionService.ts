/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from 'vscode';
import {
	AssistantMessageEntry,
	AssistantTurnStartEntry,
	SessionStartEntry,
	ToolExecutionCompleteEntry,
	ToolExecutionStartEntry,
	TranscriptEntry,
	UserMessageEntry
} from '../../../platform/chat/common/sessionTranscriptService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { ILoggedRequestInfo, ILoggedToolCall, IRequestLogger, LoggedInfo, LoggedInfoKind, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { IAgentTrajectory, IObservationResult, IToolCall, ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { createServiceIdentifier } from '../../../util/common/services';
import { ChatReplayExport, ExportedLogEntry } from '../../replay/common/chatReplayTypes';
import {
	DebugItemStatus,
	DebugRequest,
	DebugSession,
	DebugSessionMetrics,
	DebugSubAgent,
	DebugThinking,
	DebugToolCall,
	DebugTranscriptEvent,
	DebugTurn
} from '../common/debugTypes';

export const IDebugSessionService = createServiceIdentifier<IDebugSessionService>('IDebugSessionService');

export interface IDebugSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when the session data changes (for live sessions)
	 */
	readonly onDidChangeSession: Event<void>;

	/**
	 * Get the current debug session (live or loaded)
	 */
	getSession(): DebugSession | undefined;

	/**
	 * Refresh the live session data from IRequestLogger
	 */
	refreshLiveSession(): DebugSession | undefined;

	/**
	 * Load a session from a chatreplay.json export
	 */
	loadFromChatReplay(content: string, filename?: string): DebugSession;

	/**
	 * Load a session from an ATIF trajectory file
	 */
	loadFromTrajectory(content: string, filename?: string): DebugSession;

	/**
	 * Clear the loaded session and revert to live mode
	 */
	clearLoadedSession(): void;

	/**
	 * Check if we're viewing a loaded file vs live session
	 */
	isLoadedSession(): boolean;

	/**
	 * Load a session from a JSONL transcript file
	 */
	loadFromTranscript(content: string, filename?: string): DebugSession;
}

/**
 * Options for building a DebugSession from IRequestLogger
 */
export interface BuildSessionOptions {
	/** Exclude turns from the debug subagent (to avoid showing its own calls in analysis) */
	excludeDebugSubagent?: boolean;
}

/**
 * Check if a turn should be excluded because it's a debug-related turn
 */
function isDebugRelatedTurn(toolCalls: DebugToolCall[], promptText: string): boolean {
	// Exclude turns that call debug_subagent or debug_ prefixed tools
	const hasDebugToolCall = toolCalls.some(tc =>
		tc.name === 'debug_subagent' ||
		tc.name.startsWith('debug_') ||
		// Also catch tool_search_tool_regex searching for debug tools
		(tc.name === 'tool_search_tool_regex [server]' && tc.args && String(tc.args).includes('debug'))
	);

	// Exclude turns triggered by debug.prompt.md
	const isDebugPrompt = promptText.includes('debug.prompt.md');

	return hasDebugToolCall || isDebugPrompt;
}

/**
 * Build a DebugSession from IRequestLogger data
 */
export function buildSessionFromRequestLogger(
	requestLogger: IRequestLogger,
	sessionId: string = 'live',
	options?: BuildSessionOptions
): DebugSession {
	const requests = requestLogger.getRequests();

	// Group entries by CapturingToken (which represents turns/prompts)
	const turnMap = new Map<CapturingToken | undefined, LoggedInfo[]>();
	for (const info of requests) {
		const token = getToken(info);

		// Skip debug subagent's internal turns if requested
		// Check for both 'debug' (chat-invoked) and 'debug-panel' (panel-invoked)
		if (options?.excludeDebugSubagent && (token?.subAgentName === 'debug' || token?.subAgentName === 'debug-panel')) {
			continue;
		}

		if (!turnMap.has(token)) {
			turnMap.set(token, []);
		}
		turnMap.get(token)!.push(info);
	}

	const turns: DebugTurn[] = [];
	const allToolCalls: DebugToolCall[] = [];
	const allRequests: DebugRequest[] = [];
	const subAgentMap = new Map<string, DebugSubAgent>();

	let turnIndex = 0;
	for (const [token, entries] of turnMap) {
		// Skip entries without a token that don't have any tool calls
		// These are usually initialization/setup requests that aren't part of a real user turn
		if (!token) {
			const hasToolCalls = entries.some(e => e.kind === LoggedInfoKind.ToolCall);
			if (!hasToolCalls) {
				continue;
			}
		}

		const turnId = token?.label || `turn-${turnIndex}`;
		const turnToolCalls: DebugToolCall[] = [];
		const turnRequests: DebugRequest[] = [];

		const promptText = token?.label || 'Unknown prompt';
		let responseText: string | undefined;
		let turnStatus = DebugItemStatus.Success;
		let turnStart: Date | undefined;
		let turnEnd: Date | undefined;

		for (const entry of entries) {
			if (entry.kind === LoggedInfoKind.ToolCall) {
				const toolEntry = entry as ILoggedToolCall;
				const toolCall = convertToolCall(toolEntry, turnId);
				turnToolCalls.push(toolCall);
				allToolCalls.push(toolCall);

				// Track sub-agents
				if (toolEntry.toolMetadata && typeof toolEntry.toolMetadata === 'object') {
					const metadata = toolEntry.toolMetadata as Record<string, unknown>;
					const subAgentId = metadata['subAgentInvocationId'] as string | undefined;
					if (subAgentId) {
						const subAgentName = metadata['subAgentName'] as string || 'subagent';
						subAgentMap.set(subAgentId, {
							sessionId: subAgentId,
							name: subAgentName,
							parentToolCallId: toolEntry.id,
							parentSessionId: sessionId,
							children: [],
							toolCalls: [],
							depth: 1
						});
					}
				}
			} else if (entry.kind === LoggedInfoKind.Request) {
				const reqEntry = entry as ILoggedRequestInfo;
				const request = convertRequest(reqEntry, turnId);
				turnRequests.push(request);
				allRequests.push(request);

				// Extract timing
				if (reqEntry.entry.type !== LoggedRequestKind.MarkdownContentRequest) {
					const chatRequest = reqEntry.entry;
					if (!turnStart || chatRequest.startTime < turnStart) {
						turnStart = chatRequest.startTime;
					}
					if (!turnEnd || chatRequest.endTime > turnEnd) {
						turnEnd = chatRequest.endTime;
					}

					// Extract response
					if (chatRequest.type === LoggedRequestKind.ChatMLSuccess && chatRequest.isConversationRequest) {
						const result = chatRequest.result;
						if (result.value) {
							responseText = Array.isArray(result.value) ? result.value.join('\n') : String(result.value);
						}
					}

					// Track failures
					if (chatRequest.type === LoggedRequestKind.ChatMLFailure) {
						turnStatus = DebugItemStatus.Failure;
					}
				}
			}
		}

		// Check for tool call failures
		if (turnToolCalls.some(t => t.status === DebugItemStatus.Failure)) {
			turnStatus = DebugItemStatus.Failure;
		}

		// Skip debug-related turns if requested (turns that call debug_subagent or are from debug prompts)
		if (options?.excludeDebugSubagent && isDebugRelatedTurn(turnToolCalls, promptText)) {
			continue;
		}

		const turn: DebugTurn = {
			id: turnId,
			prompt: promptText,
			response: responseText,
			toolCalls: turnToolCalls,
			requests: turnRequests,
			timestamp: turnStart,
			durationMs: turnStart && turnEnd ? turnEnd.getTime() - turnStart.getTime() : undefined,
			status: turnStatus,
			index: turnIndex
		};

		turns.push(turn);
		turnIndex++;
	}

	// Second pass: populate subagent tool calls and metrics from turns that belong to subagents
	// Subagent turns have token.subAgentInvocationId set which matches DebugSubAgent.sessionId
	for (const [token, entries] of turnMap) {
		if (token?.subAgentInvocationId && subAgentMap.has(token.subAgentInvocationId)) {
			const subAgent = subAgentMap.get(token.subAgentInvocationId)!;

			// Collect tool calls from this subagent turn
			const subagentToolCalls: DebugToolCall[] = [];
			const subagentRequests: DebugRequest[] = [];
			let promptTokens = 0;
			let completionTokens = 0;

			for (const entry of entries) {
				if (entry.kind === LoggedInfoKind.ToolCall) {
					const toolEntry = entry as ILoggedToolCall;
					const toolCall = convertToolCall(toolEntry, token.label || 'subagent');
					subagentToolCalls.push(toolCall);
				} else if (entry.kind === LoggedInfoKind.Request) {
					const reqEntry = entry as ILoggedRequestInfo;
					const request = convertRequest(reqEntry, token.label || 'subagent');
					subagentRequests.push(request);

					// Extract token usage
					if (reqEntry.entry.type === LoggedRequestKind.ChatMLSuccess && reqEntry.entry.usage) {
						promptTokens += reqEntry.entry.usage.prompt_tokens || 0;
						completionTokens += reqEntry.entry.usage.completion_tokens || 0;
					}
				}
			}

			// Update the subagent entry with collected data
			// Since DebugSubAgent is readonly, we need to replace it in the map
			subAgentMap.set(token.subAgentInvocationId, {
				...subAgent,
				toolCalls: [...subAgent.toolCalls, ...subagentToolCalls],
				requests: [...(subAgent.requests || []), ...subagentRequests],
				internalTurns: (subAgent.internalTurns || 0) + 1,
				promptTokens: (subAgent.promptTokens || 0) + promptTokens,
				completionTokens: (subAgent.completionTokens || 0) + completionTokens
			});
		}
	}

	// Build sub-agent hierarchy (filter out debug subagents if requested)
	let rootSubAgents = buildSubAgentHierarchy(subAgentMap);
	if (options?.excludeDebugSubagent) {
		rootSubAgents = rootSubAgents.filter(sa => sa.name !== 'debug');
	}

	// When excluding debug subagent, filter out debug tool calls from allToolCalls and allRequests
	let filteredToolCalls = allToolCalls;
	let filteredRequests = allRequests;
	if (options?.excludeDebugSubagent) {
		filteredToolCalls = allToolCalls.filter(tc =>
			!tc.name.startsWith('debug_') &&
			tc.name !== 'debug_subagent' &&
			!(tc.name === 'tool_search_tool_regex [server]' && tc.args && String(tc.args).includes('debug'))
		);
		// Filter out requests from debug subagent (identified by debugName)
		filteredRequests = allRequests.filter(req =>
			req.name !== 'debugSubagentTool' &&
			!req.name.startsWith('debug')
		);
	}

	// Calculate metrics
	const metrics = calculateMetrics(turns, filteredToolCalls, filteredRequests, rootSubAgents);

	return {
		sessionId,
		source: 'live',
		turns,
		toolCalls: filteredToolCalls,
		requests: filteredRequests,
		subAgents: rootSubAgents,
		metrics,
		startTime: turns[0]?.timestamp,
		endTime: turns[turns.length - 1]?.timestamp
	};
}

/**
 * Build a DebugSession from ChatReplayExport
 */
export function buildSessionFromChatReplay(
	data: ChatReplayExport,
	filename?: string
): DebugSession {
	const turns: DebugTurn[] = [];
	const allToolCalls: DebugToolCall[] = [];
	const allRequests: DebugRequest[] = [];
	const subAgentMap = new Map<string, DebugSubAgent>();

	// First pass: collect all subagent internal requests (tool/runSubagent entries)
	// These are model requests made WITHIN a subagent, not the runSubagent tool call itself
	const subagentInternalRequests: DebugRequest[] = [];
	let subagentTotalPromptTokens = 0;
	let subagentTotalCompletionTokens = 0;
	let subagentStartTime: Date | undefined;
	let subagentEndTime: Date | undefined;

	for (const prompt of data.prompts) {
		for (const log of prompt.logs) {
			if (log.name === 'tool/runSubagent') {
				// This is a model request made within a subagent execution
				const response = log.response as { type?: string } | undefined;
				const request: DebugRequest = {
					id: log.id,
					name: 'subagent-internal',
					model: log.metadata?.model,
					promptTokens: log.metadata?.usage?.prompt_tokens,
					completionTokens: log.metadata?.usage?.completion_tokens,
					durationMs: log.metadata?.duration,
					timestamp: log.metadata?.startTime ? new Date(log.metadata.startTime) : undefined,
					status: response?.type === 'success' ? DebugItemStatus.Success : DebugItemStatus.Failure,
					responseType: response?.type,
					turnId: 'subagent'
				};
				subagentInternalRequests.push(request);

				// Track tokens
				if (log.metadata?.usage?.prompt_tokens) {
					subagentTotalPromptTokens += log.metadata.usage.prompt_tokens;
				}
				if (log.metadata?.usage?.completion_tokens) {
					subagentTotalCompletionTokens += log.metadata.usage.completion_tokens;
				}

				// Track timing
				if (log.metadata?.startTime) {
					const startTs = new Date(log.metadata.startTime);
					if (!subagentStartTime || startTs < subagentStartTime) {
						subagentStartTime = startTs;
					}
				}
				if (log.metadata?.endTime) {
					const endTs = new Date(log.metadata.endTime);
					if (!subagentEndTime || endTs > subagentEndTime) {
						subagentEndTime = endTs;
					}
				}
			}
		}
	}

	for (let i = 0; i < data.prompts.length; i++) {
		const prompt = data.prompts[i];
		const turnId = prompt.promptId || `turn-${i}`;
		const turnToolCalls: DebugToolCall[] = [];
		const turnRequests: DebugRequest[] = [];
		let turnStatus = DebugItemStatus.Success;
		let responseText: string | undefined;
		let earliestTimestamp: Date | undefined;
		let latestTimestamp: Date | undefined;

		for (const log of prompt.logs) {
			// Skip tool/runSubagent entries here - they're handled separately for subagent metrics
			if (log.name === 'tool/runSubagent') {
				continue;
			}

			// Track timestamps for turn duration calculation
			// Check multiple possible timestamp fields: timestamp, time, metadata.startTime
			const timeStr = log.timestamp || log.time || log.metadata?.startTime;
			if (timeStr) {
				const ts = new Date(timeStr);
				if (!isNaN(ts.getTime())) {
					if (!earliestTimestamp || ts < earliestTimestamp) {
						earliestTimestamp = ts;
					}
					if (!latestTimestamp || ts > latestTimestamp) {
						latestTimestamp = ts;
					}
				}
			}
			// Also check metadata.endTime for latest timestamp
			if (log.metadata?.endTime) {
				const endTs = new Date(log.metadata.endTime);
				if (!isNaN(endTs.getTime())) {
					if (!latestTimestamp || endTs > latestTimestamp) {
						latestTimestamp = endTs;
					}
				}
			}

			if (log.kind === 'toolCall') {
				const toolCall = convertChatReplayToolCall(log, turnId);
				turnToolCalls.push(toolCall);
				allToolCalls.push(toolCall);

				// Track runSubagent invocations
				if (log.tool === 'runSubagent' || log.name === 'runSubagent') {
					const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
					const description = log.args?.description as string || 'subagent';

					// Calculate duration from internal request timestamps
					let durationMs: number | undefined;
					if (subagentStartTime && subagentEndTime) {
						durationMs = subagentEndTime.getTime() - subagentStartTime.getTime();
					}

					subAgentMap.set(subAgentId, {
						sessionId: subAgentId,
						name: description.substring(0, 50),
						parentToolCallId: log.id,
						parentSessionId: `chatreplay-${Date.now()}`,
						children: [],
						toolCalls: [],
						depth: 1,
						// New fields for internal tracking
						internalTurns: subagentInternalRequests.length,
						requests: subagentInternalRequests,
						promptTokens: subagentTotalPromptTokens || undefined,
						completionTokens: subagentTotalCompletionTokens || undefined,
						durationMs
					});
				}
			} else if (log.kind === 'request') {
				const request = convertChatReplayRequest(log, turnId);
				turnRequests.push(request);
				allRequests.push(request);

				// Extract response from ChatMLSuccess
				if (log.type === 'ChatMLSuccess' && log.response) {
					const resp = log.response as { message?: string | string[] };
					if (resp.message) {
						responseText = Array.isArray(resp.message) ? resp.message.join('\n') : resp.message;
					}
				}

				// Track failures
				if (log.type === 'ChatMLFailure') {
					turnStatus = DebugItemStatus.Failure;
				}
			} else if (log.kind === 'error') {
				turnStatus = DebugItemStatus.Failure;
			}
		}

		if (turnToolCalls.some(t => t.status === DebugItemStatus.Failure)) {
			turnStatus = DebugItemStatus.Failure;
		}

		// Calculate duration from timestamps
		let durationMs: number | undefined;
		if (earliestTimestamp && latestTimestamp) {
			durationMs = latestTimestamp.getTime() - earliestTimestamp.getTime();
		}

		const turn: DebugTurn = {
			id: turnId,
			prompt: prompt.prompt,
			response: responseText,
			toolCalls: turnToolCalls,
			requests: turnRequests,
			timestamp: earliestTimestamp,
			durationMs,
			status: turnStatus,
			index: i
		};

		turns.push(turn);
	}

	// If we collected subagent internal requests but no explicit runSubagent tool call was found,
	// create a subagent entry from the internal request data
	if (subagentInternalRequests.length > 0 && subAgentMap.size === 0) {
		let durationMs: number | undefined;
		if (subagentStartTime && subagentEndTime) {
			durationMs = subagentEndTime.getTime() - subagentStartTime.getTime();
		}

		const subAgentId = `subagent-inferred-${Date.now()}`;
		subAgentMap.set(subAgentId, {
			sessionId: subAgentId,
			name: 'subagent',
			parentToolCallId: '',
			parentSessionId: `chatreplay-${Date.now()}`,
			children: [],
			toolCalls: [],
			depth: 1,
			internalTurns: subagentInternalRequests.length,
			requests: subagentInternalRequests,
			promptTokens: subagentTotalPromptTokens || undefined,
			completionTokens: subagentTotalCompletionTokens || undefined,
			durationMs
		});
	}

	const rootSubAgents = buildSubAgentHierarchy(subAgentMap);
	const metrics = calculateMetrics(turns, allToolCalls, allRequests, rootSubAgents);

	return {
		sessionId: `chatreplay-${Date.now()}`,
		source: 'chatreplay',
		turns,
		toolCalls: allToolCalls,
		requests: allRequests,
		subAgents: rootSubAgents,
		metrics,
		sourceFile: filename
	};
}

/**
 * Build a DebugSession from ATIF trajectory
 */
export function buildSessionFromTrajectory(
	data: IAgentTrajectory,
	filename?: string
): DebugSession {
	const turns: DebugTurn[] = [];
	const allToolCalls: DebugToolCall[] = [];
	const allRequests: DebugRequest[] = [];
	const subAgentMap = new Map<string, DebugSubAgent>();

	// Group steps into turns (user message followed by agent responses)
	let currentTurn: {
		promptText: string;
		toolCalls: DebugToolCall[];
		requests: DebugRequest[];
		responseText?: string;
		timestamp?: Date;
		status: DebugItemStatus;
	} | null = null;

	let turnIndex = 0;

	for (const step of data.steps) {
		if (step.source === 'user') {
			// Save previous turn if exists
			if (currentTurn) {
				const turn: DebugTurn = {
					id: `turn-${turnIndex}`,
					prompt: currentTurn.promptText,
					response: currentTurn.responseText,
					toolCalls: currentTurn.toolCalls,
					requests: currentTurn.requests,
					timestamp: currentTurn.timestamp,
					durationMs: undefined,
					status: currentTurn.status,
					index: turnIndex
				};
				turns.push(turn);
				turnIndex++;
			}

			// Start new turn
			currentTurn = {
				promptText: step.message,
				toolCalls: [],
				requests: [],
				timestamp: step.timestamp ? new Date(step.timestamp) : undefined,
				status: DebugItemStatus.Success
			};
		} else if (step.source === 'agent' && currentTurn) {
			// Extract tool calls
			if (step.tool_calls) {
				for (const tc of step.tool_calls) {
					const toolCall = convertTrajectoryToolCall(tc, `turn-${turnIndex}`, step);
					currentTurn.toolCalls.push(toolCall);
					allToolCalls.push(toolCall);
				}
			}

			// Extract sub-agent refs from observations
			if (step.observation?.results) {
				for (const result of step.observation.results) {
					if (result.subagent_trajectory_ref) {
						for (const ref of result.subagent_trajectory_ref) {
							subAgentMap.set(ref.session_id, {
								sessionId: ref.session_id,
								name: 'subagent',
								parentToolCallId: result.source_call_id || '',
								parentSessionId: data.session_id,
								children: [],
								toolCalls: [],
								depth: 1
							});
						}
					}
				}
			}

			// Get response text
			if (step.message) {
				currentTurn.responseText = step.message;
			}
		}
	}

	// Don't forget the last turn
	if (currentTurn) {
		const turn: DebugTurn = {
			id: `turn-${turnIndex}`,
			prompt: currentTurn.promptText,
			response: currentTurn.responseText,
			toolCalls: currentTurn.toolCalls,
			requests: currentTurn.requests,
			timestamp: currentTurn.timestamp,
			durationMs: undefined,
			status: currentTurn.status,
			index: turnIndex
		};
		turns.push(turn);
	}

	const rootSubAgents = buildSubAgentHierarchy(subAgentMap);
	const metrics = calculateMetrics(turns, allToolCalls, allRequests, rootSubAgents);

	return {
		sessionId: data.session_id,
		source: 'trajectory',
		turns,
		toolCalls: allToolCalls,
		requests: allRequests,
		subAgents: rootSubAgents,
		metrics,
		model: data.agent.model_name,
		sourceFile: filename
	};
}

/**
 * Build a DebugSession from JSONL transcript file
 */
export function buildSessionFromTranscript(
	content: string,
	filename?: string
): DebugSession {
	const lines = content.split('\n').filter(line => line.trim());
	const entries: TranscriptEntry[] = [];

	for (const line of lines) {
		try {
			entries.push(JSON.parse(line) as TranscriptEntry);
		} catch {
			// Skip malformed lines
		}
	}

	const turns: DebugTurn[] = [];
	const allToolCalls: DebugToolCall[] = [];
	const allRequests: DebugRequest[] = [];
	const allThinking: DebugThinking[] = [];
	const transcriptEvents: DebugTranscriptEvent[] = [];

	let sessionId = 'transcript';
	let sessionContext: { cwd?: string; copilotVersion?: string; vscodeVersion?: string } | undefined;

	// Track current turn state
	let currentTurnId: string | undefined;
	let currentUserMessage: string | undefined;
	let currentTurnToolCalls: DebugToolCall[] = [];
	let currentTurnResponse: string | undefined;
	let currentTurnTimestamp: Date | undefined;
	let turnIndex = 0;

	// Tool execution tracking
	const toolStartTimes = new Map<string, Date>();
	const toolArgs = new Map<string, unknown>();

	for (const entry of entries) {
		// Convert to transcript event
		transcriptEvents.push({
			type: entry.type,
			id: entry.id,
			timestamp: new Date(entry.timestamp),
			parentId: entry.parentId || undefined,
			data: entry.data as unknown as Record<string, unknown>
		});

		switch (entry.type) {
			case 'session.start': {
				const startEntry = entry as SessionStartEntry;
				sessionId = startEntry.data.sessionId;
				sessionContext = {
					cwd: startEntry.data.context?.cwd,
					copilotVersion: startEntry.data.copilotVersion,
					vscodeVersion: startEntry.data.vscodeVersion
				};
				break;
			}

			case 'user.message': {
				// If we have a previous turn, save it
				if (currentUserMessage !== undefined) {
					const turn: DebugTurn = {
						id: currentTurnId || `turn-${turnIndex}`,
						prompt: currentUserMessage,
						response: currentTurnResponse,
						toolCalls: currentTurnToolCalls,
						requests: [],
						timestamp: currentTurnTimestamp,
						durationMs: undefined,
						status: currentTurnToolCalls.some(t => t.status === DebugItemStatus.Failure)
							? DebugItemStatus.Failure
							: DebugItemStatus.Success,
						index: turnIndex
					};
					turns.push(turn);
					turnIndex++;
				}

				// Start new turn
				const userEntry = entry as UserMessageEntry;
				currentUserMessage = userEntry.data.content;
				currentTurnToolCalls = [];
				currentTurnResponse = undefined;
				currentTurnTimestamp = new Date(entry.timestamp);
				break;
			}

			case 'assistant.turn_start': {
				const turnStartEntry = entry as AssistantTurnStartEntry;
				currentTurnId = turnStartEntry.data.turnId;
				break;
			}

			case 'assistant.message': {
				const msgEntry = entry as AssistantMessageEntry;
				currentTurnResponse = msgEntry.data.content;

				// Extract thinking/reasoning
				if (msgEntry.data.reasoningText) {
					allThinking.push({
						id: msgEntry.data.messageId,
						text: msgEntry.data.reasoningText,
						turnId: currentTurnId || `turn-${turnIndex}`
					});
				}
				break;
			}

			case 'tool.execution_start': {
				const toolStartEntry = entry as ToolExecutionStartEntry;
				toolStartTimes.set(toolStartEntry.data.toolCallId, new Date(entry.timestamp));
				toolArgs.set(toolStartEntry.data.toolCallId, toolStartEntry.data.arguments);
				break;
			}

			case 'tool.execution_complete': {
				const toolEndEntry = entry as ToolExecutionCompleteEntry;
				const startTime = toolStartTimes.get(toolEndEntry.data.toolCallId);
				const args = toolArgs.get(toolEndEntry.data.toolCallId);

				// Find the tool name from the start entry
				const startEntry = entries.find(
					e => e.type === 'tool.execution_start' &&
						(e as ToolExecutionStartEntry).data.toolCallId === toolEndEntry.data.toolCallId
				) as ToolExecutionStartEntry | undefined;

				const toolCall: DebugToolCall = {
					id: toolEndEntry.data.toolCallId,
					name: startEntry?.data.toolName || 'unknown',
					args: (args as Record<string, unknown>) || {},
					result: toolEndEntry.data.result?.content?.substring(0, 200),
					fullResult: toolEndEntry.data.result?.content,
					durationMs: startTime ? new Date(entry.timestamp).getTime() - startTime.getTime() : undefined,
					timestamp: startTime,
					status: toolEndEntry.data.success ? DebugItemStatus.Success : DebugItemStatus.Failure,
					turnId: currentTurnId || `turn-${turnIndex}`
				};

				currentTurnToolCalls.push(toolCall);
				allToolCalls.push(toolCall);
				break;
			}

			case 'assistant.turn_end': {
				// Turn end - the turn will be finalized when we see the next user message
				// or at the end
				break;
			}
		}
	}

	// Don't forget the last turn
	if (currentUserMessage !== undefined) {
		const turn: DebugTurn = {
			id: currentTurnId || `turn-${turnIndex}`,
			prompt: currentUserMessage,
			response: currentTurnResponse,
			toolCalls: currentTurnToolCalls,
			requests: [],
			timestamp: currentTurnTimestamp,
			durationMs: undefined,
			status: currentTurnToolCalls.some(t => t.status === DebugItemStatus.Failure)
				? DebugItemStatus.Failure
				: DebugItemStatus.Success,
			index: turnIndex
		};
		turns.push(turn);
	}

	const metrics = calculateMetrics(turns, allToolCalls, allRequests, []);

	return {
		sessionId,
		source: 'transcript',
		turns,
		toolCalls: allToolCalls,
		requests: allRequests,
		subAgents: [],
		metrics,
		sourceFile: filename,
		thinking: allThinking.length > 0 ? allThinking : undefined,
		transcriptEvents,
		sessionContext
	};
}

// Helper functions

function getToken(info: LoggedInfo): CapturingToken | undefined {
	return info.token;
}

function convertToolCall(entry: ILoggedToolCall, turnId: string): DebugToolCall {
	// Determine status from response
	let status = DebugItemStatus.Success;
	let error: string | undefined;

	// Check if tool response indicates an error
	const responseContent = entry.response?.content;
	if (responseContent && Array.isArray(responseContent)) {
		for (const part of responseContent) {
			if (typeof part === 'object' && part !== null && 'type' in part) {
				const partObj = part as { type?: string; message?: string };
				if (partObj.type === 'error') {
					status = DebugItemStatus.Failure;
					error = partObj.message || 'Tool error';
					break;
				}
			}
		}
	}

	// Extract result as string for preview
	let result: string | undefined;
	if (responseContent && Array.isArray(responseContent)) {
		result = responseContent
			.map(p => {
				if (typeof p === 'string') {
					return p;
				}
				if (typeof p === 'object' && p !== null && 'value' in p) {
					return String((p as { value: unknown }).value);
				}
				return JSON.stringify(p);
			})
			.join('\n')
			.substring(0, 500);
	}

	return {
		id: entry.id,
		name: entry.name,
		args: entry.args as Record<string, unknown> || {},
		result: result?.substring(0, 200),
		fullResult: result,
		durationMs: undefined, // ILoggedToolCall doesn't track duration, only timestamp
		timestamp: entry.time ? new Date(entry.time) : undefined,
		status,
		error,
		turnId,
		subAgentSessionId: getSubAgentInvocationId(entry.toolMetadata),
		thinking: formatThinkingText(entry.thinking?.text)
	};
}

function convertRequest(entry: ILoggedRequestInfo, turnId: string): DebugRequest {
	const req = entry.entry;
	let status = DebugItemStatus.Success;
	let error: string | undefined;

	if (req.type === LoggedRequestKind.ChatMLFailure) {
		status = DebugItemStatus.Failure;
		error = req.result?.reason || 'Request failed';
	} else if (req.type === LoggedRequestKind.ChatMLCancelation) {
		status = DebugItemStatus.Cancelled;
	}

	let durationMs: number | undefined;
	let promptTokens: number | undefined;
	let completionTokens: number | undefined;

	if (req.type !== LoggedRequestKind.MarkdownContentRequest) {
		durationMs = req.endTime.getTime() - req.startTime.getTime();

		if (req.type === LoggedRequestKind.ChatMLSuccess && req.usage) {
			promptTokens = req.usage.prompt_tokens;
			completionTokens = req.usage.completion_tokens;
		}
	}

	return {
		id: entry.id,
		name: req.debugName,
		model: req.type !== LoggedRequestKind.MarkdownContentRequest ? req.chatEndpoint?.model : undefined,
		promptTokens,
		completionTokens,
		durationMs,
		timestamp: req.type !== LoggedRequestKind.MarkdownContentRequest ? req.startTime : undefined,
		status,
		error,
		responseType: req.type,
		turnId,
		isConversationRequest: req.type !== LoggedRequestKind.MarkdownContentRequest ? req.isConversationRequest : undefined
	};
}

function convertChatReplayToolCall(log: ExportedLogEntry, turnId: string): DebugToolCall {
	let status = DebugItemStatus.Success;
	let error: string | undefined;

	// Check for error in response
	if (log.response && typeof log.response === 'object' && 'type' in log.response) {
		const resp = log.response as { type?: string; reason?: string };
		if (resp.type === 'failure') {
			status = DebugItemStatus.Failure;
			error = resp.reason;
		}
	}
	if (log.error) {
		status = DebugItemStatus.Failure;
		error = log.error;
	}

	let result: string | undefined;
	if (log.response) {
		result = JSON.stringify(log.response).substring(0, 200);
	}

	return {
		id: log.id,
		name: log.tool || log.name || 'unknown',
		args: log.args || {},
		result,
		durationMs: undefined,
		timestamp: (log.time || log.timestamp) ? new Date(log.time || log.timestamp!) : undefined,
		status,
		error,
		turnId,
		thinking: formatThinkingText(log.thinking?.text)
	};
}

function convertChatReplayRequest(log: ExportedLogEntry, turnId: string): DebugRequest {
	let status = DebugItemStatus.Success;
	let error: string | undefined;

	if (log.type === 'ChatMLFailure') {
		status = DebugItemStatus.Failure;
		if (log.response && typeof log.response === 'object' && 'reason' in log.response) {
			error = (log.response as { reason?: string }).reason;
		}
	} else if (log.type === 'ChatMLCancelation') {
		status = DebugItemStatus.Cancelled;
	}

	return {
		id: log.id,
		name: log.name || 'request',
		model: log.metadata?.model,
		promptTokens: log.metadata?.usage?.prompt_tokens,
		completionTokens: log.metadata?.usage?.completion_tokens,
		durationMs: log.metadata?.duration,
		timestamp: log.metadata?.startTime ? new Date(log.metadata.startTime) : undefined,
		status,
		error,
		responseType: log.type,
		turnId
	};
}

function convertTrajectoryToolCall(tc: IToolCall, turnId: string, step: ITrajectoryStep): DebugToolCall {
	// Find observation result for this tool call
	let result: string | undefined;
	let error: string | undefined;
	let status = DebugItemStatus.Success;

	if (step.observation?.results) {
		const obs = step.observation.results.find((r: IObservationResult) => r.source_call_id === tc.tool_call_id);
		if (obs?.content) {
			result = obs.content.substring(0, 200);

			// Check if content indicates an error
			if (obs.content.toLowerCase().includes('error') || obs.content.toLowerCase().includes('failed')) {
				status = DebugItemStatus.Failure;
				error = obs.content.substring(0, 100);
			}
		}
	}

	return {
		id: tc.tool_call_id,
		name: tc.function_name,
		args: tc.arguments,
		result,
		durationMs: step.metrics?.duration_ms,
		timestamp: step.timestamp ? new Date(step.timestamp) : undefined,
		status,
		error,
		turnId,
		thinking: step.reasoning_content
	};
}

function buildSubAgentHierarchy(subAgentMap: Map<string, DebugSubAgent>): DebugSubAgent[] {
	// For now, just return flat list as we don't have parent linkage in the data
	// In a real implementation, we'd build the tree based on parentSessionId
	return Array.from(subAgentMap.values());
}

function calculateMetrics(
	turns: DebugTurn[],
	toolCalls: DebugToolCall[],
	requests: DebugRequest[],
	subAgents: DebugSubAgent[]
): DebugSessionMetrics {
	const toolCallsByName = new Map<string, number>();
	const errorTypes = new Map<string, number>();

	let failedToolCalls = 0;
	let failedRequests = 0;
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	for (const tc of toolCalls) {
		toolCallsByName.set(tc.name, (toolCallsByName.get(tc.name) || 0) + 1);

		if (tc.status === DebugItemStatus.Failure) {
			failedToolCalls++;
			if (tc.error) {
				const errorType = tc.error.split(':')[0] || 'Unknown';
				errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
			}
		}
	}

	for (const req of requests) {
		if (req.status === DebugItemStatus.Failure) {
			failedRequests++;
			if (req.responseType) {
				errorTypes.set(req.responseType, (errorTypes.get(req.responseType) || 0) + 1);
			}
		}
		if (req.promptTokens) {
			totalPromptTokens += req.promptTokens;
		}
		if (req.completionTokens) {
			totalCompletionTokens += req.completionTokens;
		}
	}

	// Calculate total duration from turns
	let totalDurationMs: number | undefined;
	const turnsWithDuration = turns.filter(t => t.durationMs !== undefined);
	if (turnsWithDuration.length > 0) {
		totalDurationMs = turnsWithDuration.reduce((sum, t) => sum + (t.durationMs || 0), 0);
	}

	// Calculate max sub-agent depth
	function getMaxDepth(agents: DebugSubAgent[], currentDepth: number): number {
		if (agents.length === 0) {
			return currentDepth;
		}
		return Math.max(...agents.map(a => getMaxDepth(a.children, currentDepth + 1)));
	}
	const maxSubAgentDepth = subAgents.length > 0 ? getMaxDepth(subAgents, 0) : 0;

	// Count total sub-agents recursively
	function countSubAgents(agents: DebugSubAgent[]): number {
		return agents.reduce((sum, a) => sum + 1 + countSubAgents(a.children), 0);
	}

	return {
		totalTurns: turns.length,
		totalToolCalls: toolCalls.length,
		totalRequests: requests.length,
		totalSubAgents: countSubAgents(subAgents),
		maxSubAgentDepth,
		totalDurationMs,
		totalPromptTokens: totalPromptTokens || undefined,
		totalCompletionTokens: totalCompletionTokens || undefined,
		failedToolCalls,
		failedRequests,
		toolCallsByName,
		errorTypes
	};
}

/**
 * Extract subAgentInvocationId from tool metadata
 */
function getSubAgentInvocationId(toolMetadata: unknown): string | undefined {
	if (toolMetadata && typeof toolMetadata === 'object' && 'subAgentInvocationId' in toolMetadata) {
		return (toolMetadata as { subAgentInvocationId?: string }).subAgentInvocationId;
	}
	return undefined;
}

/**
 * Format thinking text (may be string or string[])
 */
function formatThinkingText(text: string | string[] | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	return Array.isArray(text) ? text.join('\n') : text;
}
