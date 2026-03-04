/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EncryptedThinkingDelta, RawThinkingDelta, ThinkingDelta } from './thinking';

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

/**
 * Stateful parser for models (e.g. Minimax) that embed thinking inline in
 * `delta.content` using `...</think>` `<think>...</think>` tags rather than structured fields.
 *
 * Assumptions:
 * - `</think>` is a single token and will never be split across SSE chunks.
 * - Thinking always appears at the start of the response.
 * - Once `</think>` is encountered, all subsequent content is regular text.
 */
export class ContentThinkingParser {

	private state: 'thinking' | 'done' = 'thinking';

	// Tracks whether we've seen the first chunk
	private isFirstChunk = true;

	isInThinkingState(): boolean {
		return this.state === 'thinking';
	}

	/**
	 * Processes a single SSE chunk's `delta.content` string and splits it into
	 * thinking vs regular content based on the current parser state.
	 */
	processChunk(content: string): { thinking?: string; content?: string } {
		// Fast path: after </think> has been seen, all future chunks are content
		if (this.state === 'done') {
			return { content };
		}

		// strip <think> if its in the first chunk
		if (this.isFirstChunk) {
			this.isFirstChunk = false;
			if (content.startsWith(THINK_OPEN_TAG)) {
				content = content.slice(THINK_OPEN_TAG.length);
			}
		}

		// Search for the </think> boundary within this chunk.
		const closeIdx = content.indexOf(THINK_CLOSE_TAG);
		if (closeIdx === -1) {
			// No boundary found — the entire chunk is still thinking text
			return { thinking: content };
		}

		// Found the </think> boundary
		this.state = 'done';
		const thinking = content.slice(0, closeIdx);
		const after = content.slice(closeIdx + THINK_CLOSE_TAG.length);
		return {
			// Return undefined for "no thinking/content in this chunk"
			thinking: thinking || undefined,
			content: after || undefined,
		};
	}
}

function getThinkingDeltaText(thinking: RawThinkingDelta | undefined): string | undefined {
	if (!thinking) {
		return '';
	}
	if (thinking.cot_summary) {
		return thinking.cot_summary;
	}
	if (thinking.reasoning_text) {
		return thinking.reasoning_text;
	}
	if (thinking.thinking) {
		return thinking.thinking;
	}
	return undefined;
}

function getThinkingDeltaId(thinking: RawThinkingDelta | undefined): string | undefined {
	if (!thinking) {
		return undefined;
	}
	if (thinking.cot_id) {
		return thinking.cot_id;
	}
	if (thinking.reasoning_opaque) {
		return thinking.reasoning_opaque;
	}
	if (thinking.signature) {
		return thinking.signature;
	}
	return undefined;
}

export function extractThinkingDeltaFromChoice(choice: { message?: RawThinkingDelta; delta?: RawThinkingDelta }): ThinkingDelta | EncryptedThinkingDelta | undefined {
	const thinking = choice.message || choice.delta;
	if (!thinking) {
		return undefined;
	}

	const id = getThinkingDeltaId(thinking);
	const text = getThinkingDeltaText(thinking);

	if (thinking.reasoning_opaque) {
		return { id: thinking.reasoning_opaque, text, encrypted: thinking.reasoning_opaque };
	}

	if (id && text) {
		return { id, text };
	} else if (text) {
		return { text };
	} else if (id) {
		return { id };
	}
	return undefined;
}
