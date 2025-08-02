/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface RawThinkingDelta {
	// Azure Open AI fields
	cot_id?: string;
	cot_summary?: string;

	// Copilot API fields
	reasoning_opaque?: string;
	reasoning_text?: string;

	// Anthropic fields
	thinking?: string;
	signature?: string;
}

export type ThinkingDelta = {
	text?: string;
	id: string;
	metadata?: string;
} | {
	text: string;
	id?: string;
	metadata?: string;
};

export interface ThinkingData {
	id: string;
	text: string;
	metadata?: string;
}

