/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Metadata about where the cursor should move next after accepting an edit
 */
export interface CursorPredictionMetadata {
	/** The line number where the cursor should move (1-indexed) */
	readonly nextCursorLine?: number;
	/** Brief explanation of why this location makes sense */
	readonly reasoning?: string;
	/** Confidence score 0-1 */
	readonly confidence?: number;
}

/**
 * Extract cursor prediction metadata from LLM response
 */
export function extractCursorPrediction(responseText: string): CursorPredictionMetadata {
	const cursorLineMatch = responseText.match(/<next_cursor_line>(\d+)<\/next_cursor_line>/);
	const reasoningMatch = responseText.match(/<cursor_reasoning>(.*?)<\/cursor_reasoning>/s);

	if (!cursorLineMatch) {
		return {};
	}

	return {
		nextCursorLine: parseInt(cursorLineMatch[1]),
		reasoning: reasoningMatch?.[1]?.trim(),
		confidence: 0.85 // Default confidence for now
	};
}

/**
 * Remove cursor prediction tags from response text
 */
export function removeCursorPredictionTags(responseText: string): string {
	return responseText
		.replace(/<next_cursor_line>.*?<\/next_cursor_line>/gs, '')
		.replace(/<cursor_reasoning>.*?<\/cursor_reasoning>/gs, '')
		.trim();
}
