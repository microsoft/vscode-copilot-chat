/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure view logic for the Agent Debug Panel.
 *
 * **Zero `vscode.*` imports.** All functions are framework-agnostic
 * and can be used by both the extension host and the webview.
 * This file copies to VS Code core unchanged if migrating.
 */

import {
	AgentDebugEventCategory,
	IAgentDebugEvent,
	IAgentDebugEventFilter,
	IErrorEvent,
	ILLMRequestEvent,
	ILoopControlEvent,
	ISessionSummary,
	IToolCallEvent,
} from './agentDebugTypes';

/**
 * A node in the event tree. Top-level events have no parentEventId.
 * SubAgent events contain children nested underneath.
 */
export interface IEventTreeNode {
	readonly event: IAgentDebugEvent;
	readonly children: IEventTreeNode[];
}

/**
 * Build a tree from a flat chronological event list.
 * Events with `parentEventId` become children of the matching parent;
 * all others become top-level nodes.
 */
export function buildEventTree(events: readonly IAgentDebugEvent[]): IEventTreeNode[] {
	const nodeMap = new Map<string, IEventTreeNode>();
	const roots: IEventTreeNode[] = [];

	// First pass: create nodes for all events
	for (const event of events) {
		nodeMap.set(event.id, { event, children: [] });
	}

	// Second pass: wire parent → children
	for (const event of events) {
		const node = nodeMap.get(event.id)!;
		const parentId = event.parentEventId;
		if (parentId) {
			const parent = nodeMap.get(parentId);
			if (parent) {
				(parent.children as IEventTreeNode[]).push(node);
				continue;
			}
		}
		roots.push(node);
	}

	return roots;
}

export function groupEventsBySession(events: readonly IAgentDebugEvent[]): Map<string, IAgentDebugEvent[]> {
	const map = new Map<string, IAgentDebugEvent[]>();
	for (const e of events) {
		let list = map.get(e.sessionId);
		if (!list) {
			list = [];
			map.set(e.sessionId, list);
		}
		list.push(e);
	}
	return map;
}

export function filterEvents(events: readonly IAgentDebugEvent[], filter: IAgentDebugEventFilter): IAgentDebugEvent[] {
	return events.filter(e => {
		if (filter.categories && filter.categories.length > 0) {
			if (!filter.categories.includes(e.category as AgentDebugEventCategory)) {
				return false;
			}
		}
		if (filter.sessionId && e.sessionId !== filter.sessionId) {
			return false;
		}
		if (filter.timeRange) {
			if (e.timestamp < filter.timeRange.start || e.timestamp > filter.timeRange.end) {
				return false;
			}
		}
		return true;
	});
}

export function getEventIcon(event: IAgentDebugEvent): string {
	switch (event.category) {
		case AgentDebugEventCategory.Discovery: return 'search';
		case AgentDebugEventCategory.ToolCall: return 'tools';
		case AgentDebugEventCategory.LLMRequest: return 'cloud';
		case AgentDebugEventCategory.Error: return 'error';
		case AgentDebugEventCategory.LoopControl: return 'sync';
	}
}

export function getEventStatusClass(event: IAgentDebugEvent): string {
	switch (event.category) {
		case AgentDebugEventCategory.Error:
			return 'status-error';
		case AgentDebugEventCategory.ToolCall: {
			const tc = event as IToolCallEvent;
			if (tc.status === 'failure') {
				return 'status-error';
			}
			if (tc.status === 'pending') {
				return 'status-warning';
			}
			return 'status-success';
		}
		case AgentDebugEventCategory.LLMRequest: {
			const lr = event as ILLMRequestEvent;
			if (lr.status === 'failure') {
				return 'status-error';
			}
			return 'status-success';
		}
		case AgentDebugEventCategory.LoopControl: {
			const lc = event as ILoopControlEvent;
			if (lc.loopAction === 'stop' && lc.reason) {
				return 'status-warning';
			}
			return 'status-info';
		}
		case AgentDebugEventCategory.Discovery:
			return 'status-info';
	}
}

export function formatEventDetail(event: IAgentDebugEvent): Record<string, string> {
	const result: Record<string, string> = {};

	switch (event.category) {
		case AgentDebugEventCategory.ToolCall: {
			const tc = event as IToolCallEvent;
			result['Tool'] = tc.toolName;
			result['Status'] = tc.status;
			if (tc.subAgentName) {
				result['SubAgent'] = tc.subAgentName;
			}
			result['Args'] = tc.argsSummary;
			if (tc.durationMs !== undefined) {
				result['Duration'] = `${tc.durationMs}ms`;
			}
			if (tc.resultSummary) {
				result['Result'] = tc.resultSummary;
			}
			if (tc.errorMessage) {
				result['Error'] = tc.errorMessage;
			}
			break;
		}
		case AgentDebugEventCategory.LLMRequest: {
			const lr = event as ILLMRequestEvent;
			result['Request'] = lr.requestName;
			result['Duration'] = `${lr.durationMs}ms`;
			result['Prompt Tokens'] = String(lr.promptTokens);
			result['Completion Tokens'] = String(lr.completionTokens);
			result['Cached Tokens'] = String(lr.cachedTokens);
			result['Total Tokens'] = String(lr.totalTokens);
			result['Status'] = lr.status;
			if (lr.errorMessage) {
				result['Error'] = lr.errorMessage;
			}
			break;
		}
		case AgentDebugEventCategory.Error: {
			const ee = event as IErrorEvent;
			result['Type'] = ee.errorType;
			if (ee.originalError) {
				result['Error'] = ee.originalError;
			}
			if (ee.toolName) {
				result['Tool'] = ee.toolName;
			}
			break;
		}
		case AgentDebugEventCategory.LoopControl: {
			const lc = event as ILoopControlEvent;
			result['Action'] = lc.loopAction;
			if (lc.iterationIndex !== undefined) {
				result['Iteration'] = String(lc.iterationIndex);
			}
			if (lc.reason) {
				result['Reason'] = lc.reason;
			}
			break;
		}
		case AgentDebugEventCategory.Discovery: {
			for (const [k, v] of Object.entries(event.details)) {
				result[k] = String(v);
			}
			break;
		}
	}

	return result;
}

export function sortEventsChronologically(events: readonly IAgentDebugEvent[]): IAgentDebugEvent[] {
	return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

export function computeSessionSummary(events: readonly IAgentDebugEvent[]): ISessionSummary {
	let toolCount = 0;
	let totalTokens = 0;
	let cachedTokens = 0;
	let errorCount = 0;
	let minTime = Infinity;
	let maxTime = -Infinity;

	for (const e of events) {
		if (e.timestamp < minTime) {
			minTime = e.timestamp;
		}
		if (e.timestamp > maxTime) {
			maxTime = e.timestamp;
		}

		switch (e.category) {
			case AgentDebugEventCategory.ToolCall:
				toolCount++;
				break;
			case AgentDebugEventCategory.LLMRequest: {
				const lr = e as ILLMRequestEvent;
				totalTokens += lr.totalTokens;
				cachedTokens += lr.cachedTokens;
				break;
			}
			case AgentDebugEventCategory.Error:
				errorCount++;
				break;
		}
	}

	const durationMs = minTime === Infinity ? 0 : maxTime - minTime;
	const cachedTokenRatio = totalTokens > 0 ? cachedTokens / totalTokens : 0;

	return {
		toolCount,
		totalTokens,
		durationMs,
		errorCount,
		cachedTokenRatio,
	};
}

export function formatCategoryLabel(category: AgentDebugEventCategory): string {
	switch (category) {
		case AgentDebugEventCategory.Discovery: return 'Discovery';
		case AgentDebugEventCategory.ToolCall: return 'Tool Call';
		case AgentDebugEventCategory.LLMRequest: return 'LLM Request';
		case AgentDebugEventCategory.Error: return 'Error';
		case AgentDebugEventCategory.LoopControl: return 'Loop Control';
	}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const secs = ms / 1000;
	if (secs < 60) {
		return `${secs.toFixed(1)}s`;
	}
	const mins = Math.floor(secs / 60);
	const remSecs = Math.floor(secs % 60);
	return `${mins}:${String(remSecs).padStart(2, '0')}`;
}

export function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
