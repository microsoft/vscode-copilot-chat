/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EncryptedThinkingDelta, RawThinkingDelta, ThinkingDelta } from './thinking';

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
	// Handle OpenRouter reasoning_details format
	if (thinking.reasoning_details && thinking.reasoning_details.length > 0) {
		const texts: string[] = [];
		for (const detail of thinking.reasoning_details) {
			if (detail.type === 'reasoning.text' && detail.text) {
				texts.push(detail.text);
			} else if (detail.type === 'reasoning.summary' && detail.summary) {
				texts.push(detail.summary);
			}
		}
		if (texts.length > 0) {
			return texts.join('');
		}
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
	// Handle OpenRouter reasoning_details format
	if (thinking.reasoning_details && thinking.reasoning_details.length > 0) {
		for (const detail of thinking.reasoning_details) {
			if (detail.id) {
				return detail.id;
			}
		}
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

	// reasoning_opaque is encrypted content that should be marked as such
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
