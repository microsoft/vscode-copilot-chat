/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { FetchSuccess } from '../../../platform/chat/common/commonTypes';
import { isEncryptedThinkingDelta, ThinkingData, ThinkingDelta } from '../../../platform/thinking/common/thinking';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IToolCall, IToolCallRound } from './intents';


/**
 * Represents a round of tool calling from the AI assistant.
 * Each round contains the assistant's response text, any tool calls it made,
 * and retry information if there were input validation issues.
 */
export class ToolCallRound implements IToolCallRound {
	public summary: string | undefined;

	/**
	 * Creates a ToolCallRound from an existing IToolCallRound object.
	 * Prefer this over using a constructor overload to keep construction explicit.
	 */
	public static create(params: Omit<IToolCallRound, 'id'> & { id?: string }): ToolCallRound {
		const round = new ToolCallRound(
			params.response,
			params.toolCalls,
			params.toolInputRetry,
			params.id,
			params.statefulMarker,
			params.thinking
		);
		round.summary = params.summary;
		return round;
	}

	/**
	 * @param response The text response from the assistant
	 * @param toolCalls The tool calls made by the assistant
	 * @param toolInputRetry The number of times this round has been retried due to tool input validation failures
	 * @param id A stable identifier for this round
	 * @param statefulMarker Optional stateful marker used with the responses API
	 */
	constructor(
		public readonly response: string,
		public readonly toolCalls: IToolCall[] = [],
		public readonly toolInputRetry: number = 0,
		public readonly id: string = ToolCallRound.generateID(),
		public readonly statefulMarker?: string,
		public readonly thinking?: ThinkingData
	) { }

	private static generateID(): string {
		return generateUuid();
	}
}

export interface ToolCallLoopDetectionResult {
	readonly toolCountsWindow: Record<string, number>;
	readonly windowSize: number;
	readonly uniqueToolKeyCount: number;
	readonly maxKeyCount: number;
	readonly totalToolCallRounds: number;
	readonly totalToolCalls: number;
}

export function detectToolCallLoop(toolCallRounds: readonly IToolCallRound[]): ToolCallLoopDetectionResult | undefined {
	const allCalls: IToolCall[] = [];
	for (const round of toolCallRounds) {
		if (!round.toolCalls.length) {
			continue;
		}
		for (const call of round.toolCalls) {
			allCalls.push(call);
		}
	}

	// Require a minimum number of calls overall before we even consider this a loop.
	const minTotalCalls = 12;
	if (allCalls.length < minTotalCalls) {
		return undefined;
	}

	// Look at a sliding window of the most recent calls to see if
	// the model is bouncing between the same one or two tool invocations.
	const windowSize = 20;
	const recent = allCalls.slice(-Math.min(windowSize, allCalls.length));
	if (recent.length < minTotalCalls) {
		return undefined;
	}

	const toolCountsWindow: Record<string, number> = Object.create(null);
	for (const call of recent) {
		const key = `${call.name}:${call.arguments}`;
		toolCountsWindow[key] = (toolCountsWindow[key] || 0) + 1;
	}

	const keys = Object.keys(toolCountsWindow);
	const uniqueToolKeyCount = keys.length;
	if (uniqueToolKeyCount === 0) {
		return undefined;
	}

	// We only consider it a loop if the recent window is dominated by
	// one or two repeating tool+argument combinations.
	const maxKeyCount = keys.reduce((max, key) => Math.max(max, toolCountsWindow[key]), 0);
	const maxDistinctKeys = 2;
	const minRepeatsForLoop = 6;
	if (uniqueToolKeyCount <= maxDistinctKeys && maxKeyCount >= minRepeatsForLoop) {
		return {
			toolCountsWindow,
			windowSize: recent.length,
			uniqueToolKeyCount,
			maxKeyCount,
			totalToolCallRounds: toolCallRounds.length,
			totalToolCalls: allCalls.length,
		};
	}

	return undefined;
}

export interface ITextLoopDetectionResult {
	readonly repeatCount: number;
	readonly totalSentences: number;
	readonly totalRounds: number;
	readonly responseLength: number;
}

function splitSentences(text: string): string[] {
	return text
		.split(/[\.\!\?\n\r]+/g)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

function normalizeSentence(sentence: string): string {
	return sentence
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export function detectTextLoop(toolCallRounds: readonly IToolCallRound[]): ITextLoopDetectionResult | undefined {
	const lastRound = toolCallRounds.at(-1);
	if (!lastRound) {
		return undefined;
	}

	const response = lastRound.response;
	const minResponseLength = 200;
	if (!response || response.length < minResponseLength) {
		return undefined;
	}

	const sentences = splitSentences(response);
	if (sentences.length < 3) {
		return undefined;
	}

	const sentenceCounts: Record<string, number> = Object.create(null);
	let maxCount = 0;
	for (const sentence of sentences) {
		const normalized = normalizeSentence(sentence);
		if (normalized.length < 30) {
			continue;
		}
		const count = (sentenceCounts[normalized] || 0) + 1;
		sentenceCounts[normalized] = count;
		if (count > maxCount) {
			maxCount = count;
		}
	}

	const minRepeatsForTextLoop = 3;
	if (maxCount >= minRepeatsForTextLoop) {
		return {
			repeatCount: maxCount,
			totalSentences: sentences.length,
			totalRounds: toolCallRounds.length,
			responseLength: response.length,
		};
	}

	return undefined;
}

export class ThinkingDataItem implements ThinkingData {
	public text: string | string[] = '';
	public metadata?: { [key: string]: any };
	public tokens?: number;
	public encrypted?: string;

	static createOrUpdate(item: ThinkingDataItem | undefined, delta: ThinkingDelta) {
		if (!item) {
			item = new ThinkingDataItem(delta.id ?? generateUuid());
		}

		item.update(delta);
		return item;
	}

	constructor(
		public id: string
	) { }

	public update(delta: ThinkingDelta): void {
		if (delta.id && this.id !== delta.id) {
			this.id = delta.id;
		}
		if (isEncryptedThinkingDelta(delta)) {
			this.encrypted = delta.encrypted;
		}
		if (delta.text !== undefined) {

			// handles all possible text states
			if (Array.isArray(delta.text)) {
				if (Array.isArray(this.text)) {
					this.text.push(...delta.text);
				} else if (this.text) {
					this.text = [this.text, ...delta.text];
				} else {
					this.text = [...delta.text];
				}
			} else {
				if (Array.isArray(this.text)) {
					this.text.push(delta.text);
				} else {
					this.text += delta.text;
				}
			}
		}
		if (delta.metadata) {
			this.metadata = delta.metadata;
		}
	}

	public updateWithFetchResult(fetchResult: FetchSuccess<unknown>): void {
		this.tokens = fetchResult.usage?.completion_tokens_details?.reasoning_tokens;
	}
}