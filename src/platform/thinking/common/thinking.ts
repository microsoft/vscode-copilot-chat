/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export interface ThinkingData {
	/** Thinking token identifier (cot_id for AOAI, reasoning_opaque for CAPI) */
	cot_id?: string;
	reasoning_opaque?: string;
	/** Thinking token content (cot_summary for AOAI, reasoning_text for CAPI) */
	cot_summary?: string;
	reasoning_text?: string;
}