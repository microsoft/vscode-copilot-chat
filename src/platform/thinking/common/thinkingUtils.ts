/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThinkingData } from './thinking';

export function getThinkingText(thinking: ThinkingData | undefined): string {
	if (!thinking) {
		return '';
	}
	if (thinking.cot_summary) {
		return thinking.cot_summary;
	}
	if (thinking.reasoning_text) {
		return thinking.reasoning_text;
	}
	return '';
}

export function getThinkingId(thinking: ThinkingData | undefined): string | undefined {
	if (!thinking) {
		return undefined;
	}
	if (thinking.cot_id) {
		return thinking.cot_id;
	}
	if (thinking.reasoning_opaque) {
		return thinking.reasoning_opaque;
	}
	return undefined;
}