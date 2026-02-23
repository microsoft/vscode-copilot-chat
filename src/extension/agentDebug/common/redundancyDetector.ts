/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Redundancy detector for agent tool calls.
 *
 * **Zero `vscode.*` imports.** Pure logic that analyses tool call events
 * for patterns indicating wasted work: exact duplicates, oscillating
 * patterns (A→B→A→B), and excessive retries. This file copies to
 * VS Code core unchanged if migrating.
 */

import { AgentDebugEventCategory, IErrorEvent, IToolCallEvent } from './agentDebugTypes';

export interface IRedundancyPattern {
	readonly type: 'duplicate' | 'oscillation' | 'excessiveRetry';
	readonly toolName: string;
	readonly occurrences: number;
	readonly description: string;
}

const MAX_RETRY_THRESHOLD = 3;

/**
 * Detects redundancy patterns in a stream of tool call events.
 * Call {@link addToolCall} for each new tool call; it returns any
 * newly-detected patterns.
 */
export class RedundancyDetector {

	/** Keyed by `toolName|argsSummary`, counts repeated identical calls. */
	private readonly _callCounts = new Map<string, number>();

	/** Keyed by `toolName`, counts consecutive calls with any args. */
	private readonly _consecutiveRetryCounts = new Map<string, number>();

	/** Tracks last N tool names for oscillation detection. */
	private readonly _recentToolNames: string[] = [];
	private _lastToolKey: string | undefined;

	addToolCall(event: IToolCallEvent): IRedundancyPattern[] {
		const patterns: IRedundancyPattern[] = [];

		const callKey = `${event.toolName}|${event.argsSummary}`;

		// --- Exact duplicate detection ---
		const count = (this._callCounts.get(callKey) ?? 0) + 1;
		this._callCounts.set(callKey, count);

		// Only fire at the threshold crossing (2nd occurrence), not on every subsequent call
		if (count === 2) {
			patterns.push({
				type: 'duplicate',
				toolName: event.toolName,
				occurrences: count,
				description: `"${event.toolName}" called ${count} times with identical args`,
			});
		}

		// --- Excessive retry detection (same tool, any args) ---
		if (callKey === this._lastToolKey) {
			const retries = (this._consecutiveRetryCounts.get(event.toolName) ?? 1) + 1;
			this._consecutiveRetryCounts.set(event.toolName, retries);

			if (retries >= MAX_RETRY_THRESHOLD) {
				patterns.push({
					type: 'excessiveRetry',
					toolName: event.toolName,
					occurrences: retries,
					description: `"${event.toolName}" called ${retries} consecutive times`,
				});
			}
		} else {
			this._consecutiveRetryCounts.set(event.toolName, 1);
		}
		this._lastToolKey = callKey;

		// --- Oscillation detection (A→B→A→B) ---
		this._recentToolNames.push(event.toolName);
		if (this._recentToolNames.length > 8) {
			this._recentToolNames.shift();
		}

		const oscillation = detectOscillation(this._recentToolNames);
		if (oscillation) {
			patterns.push(oscillation);
		}

		return patterns;
	}

	/**
	 * Converts a detected pattern into an `IErrorEvent` shape
	 * (missing `id` and `timestamp` — caller supplies those).
	 */
	static toPartialErrorEvent(pattern: IRedundancyPattern, sessionId: string): Omit<IErrorEvent, 'id' | 'timestamp'> {
		return {
			category: AgentDebugEventCategory.Error,
			sessionId,
			summary: `Redundancy: ${pattern.description}`,
			details: { type: pattern.type, toolName: pattern.toolName, occurrences: pattern.occurrences },
			errorType: 'redundancy',
			originalError: pattern.description,
			toolName: pattern.toolName,
		};
	}
}

/**
 * Detects A→B→A→B oscillation in the last N tool names.
 * Requires at least 4 entries and at least 2 full cycles of the same pair.
 */
function detectOscillation(names: readonly string[]): IRedundancyPattern | undefined {
	if (names.length < 4) {
		return undefined;
	}

	// Check the tail for A→B→A→B pattern
	const len = names.length;
	const a = names[len - 4];
	const b = names[len - 3];
	if (a === b) {
		return undefined; // Need two distinct tools
	}
	if (names[len - 2] === a && names[len - 1] === b) {
		return {
			type: 'oscillation',
			toolName: `${a} ↔ ${b}`,
			occurrences: 2,
			description: `Oscillating pattern detected: "${a}" ↔ "${b}"`,
		};
	}
	return undefined;
}
