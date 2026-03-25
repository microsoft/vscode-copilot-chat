/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	TRAJECTORY_SCHEMA_VERSION,
	type IAgentTrajectory,
	type IFinalMetrics,
	type IObservation,
	type IObservationResult,
	type IStepMetrics,
	type ISubagentTrajectoryRef,
	type IToolCall,
	type ITrajectoryStep,
} from '../../common/atif/atifTypes';
import { CopilotChatAttr, GenAiAttr } from '../../common/genAiAttributes';
import type { OTelSqliteStore, SpanEventRow, SpanRow } from '../sqlite/otelSqliteStore';

// ── Internal span tree node ─────────────────────────────────────────────────────

interface SpanNode {
	span: SpanRow;
	events: SpanEventRow[];
	children: SpanNode[];
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Convert OTel spans from the SQLite store into ATIF trajectories.
 *
 * Reads all spans for a trace, builds the parent/child tree, and walks it
 * depth-first to produce IAgentTrajectory with steps, tool calls, observations,
 * and subagent references.
 *
 * @param store The OTel SQLite store to read from
 * @param traceId The trace ID to convert
 * @returns Main trajectory and any subagent trajectories
 */
export function convertTraceToAtif(
	store: OTelSqliteStore,
	traceId: string,
): { main: IAgentTrajectory | undefined; subagents: Map<string, IAgentTrajectory> } {
	const spans = store.getSpansByTraceId(traceId);
	if (spans.length === 0) {
		return { main: undefined, subagents: new Map() };
	}

	// Build span tree
	const roots = buildSpanTree(spans, store);

	// Find invoke_agent root spans
	const agentRoots = findAgentRoots(roots);
	if (agentRoots.length === 0) {
		return { main: undefined, subagents: new Map() };
	}

	const subagents = new Map<string, IAgentTrajectory>();
	let main: IAgentTrajectory | undefined;

	for (const agentRoot of agentRoots) {
		const trajectory = buildTrajectoryFromAgentNode(agentRoot, store, subagents);
		if (!main) {
			main = trajectory;
		} else {
			subagents.set(trajectory.session_id, trajectory);
		}
	}

	return { main, subagents };
}

/**
 * Convert all traces for a conversation into ATIF trajectories.
 */
export function convertConversationToAtif(
	store: OTelSqliteStore,
	conversationId: string,
): { main: IAgentTrajectory | undefined; subagents: Map<string, IAgentTrajectory> } {
	const traceIds = store.getTraceIds(conversationId);
	if (traceIds.length === 0) {
		return { main: undefined, subagents: new Map() };
	}

	// Convert each trace and merge results
	let main: IAgentTrajectory | undefined;
	const allSubagents = new Map<string, IAgentTrajectory>();

	for (const traceId of traceIds) {
		const result = convertTraceToAtif(store, traceId);
		if (result.main && !main) {
			main = result.main;
		} else if (result.main) {
			allSubagents.set(result.main.session_id, result.main);
		}
		for (const [id, sub] of result.subagents) {
			allSubagents.set(id, sub);
		}
	}

	return { main, subagents: allSubagents };
}

// ── Tree building ───────────────────────────────────────────────────────────────

function buildSpanTree(spans: SpanRow[], store: OTelSqliteStore): SpanNode[] {
	const nodes = new Map<string, SpanNode>();
	for (const span of spans) {
		nodes.set(span.span_id, {
			span,
			events: store.getSpanEvents(span.span_id),
			children: [],
		});
	}

	const roots: SpanNode[] = [];
	for (const node of nodes.values()) {
		if (node.span.parent_span_id && nodes.has(node.span.parent_span_id)) {
			nodes.get(node.span.parent_span_id)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Sort children by start time
	for (const node of nodes.values()) {
		node.children.sort((a, b) => a.span.start_time_ms - b.span.start_time_ms);
	}

	return roots;
}

function findAgentRoots(roots: SpanNode[]): SpanNode[] {
	const result: SpanNode[] = [];
	for (const root of roots) {
		if (root.span.operation_name === 'invoke_agent') {
			result.push(root);
		} else {
			result.push(...findAgentRoots(root.children));
		}
	}
	return result;
}

// ── Trajectory building ─────────────────────────────────────────────────────────

function buildTrajectoryFromAgentNode(
	agentNode: SpanNode,
	store: OTelSqliteStore,
	allSubagents: Map<string, IAgentTrajectory>,
): IAgentTrajectory {
	const span = agentNode.span;
	const sessionId = span.chat_session_id ?? span.conversation_id ?? span.span_id;
	const agentName = span.agent_name
		?? (span.name.replace(/^invoke_agent\s*/, '').trim() || 'copilot');

	const steps: ITrajectoryStep[] = [];
	let stepCounter = 0;
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	let totalCachedTokens = 0;
	let totalToolCalls = 0;
	let firstModelName: string | undefined;

	for (const child of agentNode.children) {
		const op = child.span.operation_name;

		if (op === 'chat') {
			// User message from span events
			for (const evt of child.events) {
				if (evt.name === 'user_message') {
					stepCounter++;
					const content = evt.attributes ? tryParseAttr(evt.attributes, 'content') : '';
					steps.push({
						step_id: stepCounter,
						timestamp: new Date(evt.timestamp_ms).toISOString(),
						source: 'user',
						message: content,
					});
				}
			}

			// Agent step
			const modelName = child.span.response_model ?? child.span.request_model ?? undefined;
			if (!firstModelName && modelName) {
				firstModelName = modelName;
			}

			const outputMessages = store.getSpanAttribute(child.span.span_id, GenAiAttr.OUTPUT_MESSAGES);
			const message = extractTextFromOutputMessages(outputMessages);
			const reasoning = store.getSpanAttribute(child.span.span_id, CopilotChatAttr.REASONING_CONTENT);

			const promptTokens = child.span.input_tokens ?? 0;
			const completionTokens = child.span.output_tokens ?? 0;
			const cachedTokens = child.span.cached_tokens ?? 0;
			const durationMs = child.span.end_time_ms - child.span.start_time_ms;

			totalPromptTokens += promptTokens;
			totalCompletionTokens += completionTokens;
			totalCachedTokens += cachedTokens;

			// Collect tool calls that are children of this chat span
			const toolCalls: IToolCall[] = [];
			const observationResults: IObservationResult[] = [];

			for (const toolChild of child.children) {
				if (toolChild.span.operation_name === 'execute_tool') {
					const tc = extractToolCall(toolChild, store);
					toolCalls.push(tc.toolCall);
					observationResults.push(tc.observation);
					totalToolCalls++;

					// Check for subagent
					for (const subChild of toolChild.children) {
						if (subChild.span.operation_name === 'invoke_agent') {
							const subTrajectory = buildTrajectoryFromAgentNode(subChild, store, allSubagents);
							allSubagents.set(subTrajectory.session_id, subTrajectory);
							const lastObs = observationResults[observationResults.length - 1];
							if (lastObs) {
								(lastObs as { subagent_trajectory_ref?: ISubagentTrajectoryRef[] }).subagent_trajectory_ref = [{
									session_id: subTrajectory.session_id,
									trajectory_path: `${sanitizeFilename(subTrajectory.session_id)}.trajectory.json`,
								}];
							}
						}
					}
				}
			}

			stepCounter++;
			const metrics: IStepMetrics = {
				prompt_tokens: promptTokens || undefined,
				completion_tokens: completionTokens || undefined,
				cached_tokens: cachedTokens || undefined,
				time_to_first_token_ms: child.span.ttft_ms ?? undefined,
				duration_ms: Math.round(durationMs),
			};
			const hasMetrics = metrics.prompt_tokens || metrics.completion_tokens || metrics.cached_tokens || metrics.time_to_first_token_ms || metrics.duration_ms;

			const agentStep: ITrajectoryStep = {
				step_id: stepCounter,
				timestamp: new Date(child.span.start_time_ms).toISOString(),
				source: 'agent',
				model_name: modelName,
				message,
				...(reasoning ? { reasoning_content: reasoning } : {}),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls, observation: { results: observationResults } } : {}),
				...(hasMetrics ? { metrics } : {}),
			};

			steps.push(agentStep);
		} else if (op === 'execute_tool') {
			// Tool calls that are direct children of invoke_agent
			const tc = extractToolCall(child, store);
			totalToolCalls++;

			// Check for subagent
			for (const subChild of child.children) {
				if (subChild.span.operation_name === 'invoke_agent') {
					const subTrajectory = buildTrajectoryFromAgentNode(subChild, store, allSubagents);
					allSubagents.set(subTrajectory.session_id, subTrajectory);
					(tc.observation as { subagent_trajectory_ref?: ISubagentTrajectoryRef[] }).subagent_trajectory_ref = [{
						session_id: subTrajectory.session_id,
						trajectory_path: `${sanitizeFilename(subTrajectory.session_id)}.trajectory.json`,
					}];
				}
			}

			// Attach to previous agent step, or create new one
			const lastAgentStep = [...steps].reverse().find(s => s.source === 'agent') as ITrajectoryStep & { tool_calls?: IToolCall[]; observation?: IObservation } | undefined;
			if (lastAgentStep) {
				const mutableStep = lastAgentStep as { tool_calls?: IToolCall[]; observation?: { results: IObservationResult[] } };
				if (!mutableStep.tool_calls) { mutableStep.tool_calls = []; }
				if (!mutableStep.observation) { mutableStep.observation = { results: [] }; }
				mutableStep.tool_calls.push(tc.toolCall);
				mutableStep.observation.results.push(tc.observation);
			} else {
				stepCounter++;
				steps.push({
					step_id: stepCounter,
					timestamp: new Date(child.span.start_time_ms).toISOString(),
					source: 'agent',
					message: '',
					tool_calls: [tc.toolCall],
					observation: { results: [tc.observation] },
				});
			}
		}
	}

	const trajectory: IAgentTrajectory = {
		schema_version: TRAJECTORY_SCHEMA_VERSION,
		session_id: sessionId,
		agent: {
			name: agentName,
			version: '1.0.0',
			model_name: firstModelName,
		},
		steps,
	};

	if (totalPromptTokens > 0 || totalCompletionTokens > 0 || totalToolCalls > 0) {
		(trajectory as { final_metrics?: IFinalMetrics }).final_metrics = {
			total_prompt_tokens: totalPromptTokens || undefined,
			total_completion_tokens: totalCompletionTokens || undefined,
			total_cached_tokens: totalCachedTokens || undefined,
			total_steps: steps.length,
			total_tool_calls: totalToolCalls || undefined,
		};
	}

	return trajectory;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function extractToolCall(
	node: SpanNode,
	store: OTelSqliteStore,
): { toolCall: IToolCall; observation: IObservationResult } {
	const toolName = node.span.tool_name ?? node.span.name.replace(/^execute_tool\s*/, '').trim();
	const toolCallId = node.span.tool_call_id ?? node.span.span_id;
	const argsStr = store.getSpanAttribute(node.span.span_id, GenAiAttr.TOOL_CALL_ARGUMENTS);
	const resultStr = store.getSpanAttribute(node.span.span_id, GenAiAttr.TOOL_CALL_RESULT);

	return {
		toolCall: {
			tool_call_id: toolCallId,
			function_name: toolName,
			arguments: tryParseJson(argsStr),
		},
		observation: {
			source_call_id: toolCallId,
			content: resultStr ?? '',
		},
	};
}

function extractTextFromOutputMessages(outputMessages: string | null): string {
	if (!outputMessages) { return ''; }
	try {
		const parsed = JSON.parse(outputMessages) as Array<{
			role?: string;
			parts?: Array<{ type?: string; content?: unknown }>;
		}>;
		const texts: string[] = [];
		for (const msg of parsed) {
			if (!msg.parts) { continue; }
			for (const part of msg.parts) {
				if (part.type === 'text' && typeof part.content === 'string') {
					texts.push(part.content);
				}
			}
		}
		return texts.join('\n').trim();
	} catch {
		return outputMessages;
	}
}

function tryParseJson(s: string | null): Record<string, unknown> {
	if (!s) { return {}; }
	try {
		const parsed = JSON.parse(s);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function tryParseAttr(jsonStr: string, key: string): string {
	try {
		const parsed = JSON.parse(jsonStr);
		return typeof parsed === 'object' && parsed !== null ? String(parsed[key] ?? '') : '';
	} catch {
		return '';
	}
}

function sanitizeFilename(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}
