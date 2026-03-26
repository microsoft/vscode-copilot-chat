/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../util/vs/editor/common/core/position';
import { CurrentDocument } from './xtabCurrentDocument';

/**
 * Checks if the position is valid inline suggestion position (middle of the line).
 * Returns `undefined` if it's position where ghost text shouldn't be displayed.
 *
 * @param textAfterCursor - The text from the cursor position to the end of line
 */
export function isInlineSuggestionFromTextAfterCursor(textAfterCursor: string): boolean | undefined {
	// Checks if we're in the position for the middle of the line suggestion
	const isMiddleOfLine = isMiddleOfTheLineFromTextAfterCursor(textAfterCursor);
	const isValidMiddleOfLine = isValidMiddleOfTheLineFromTextAfterCursor(textAfterCursor);

	if (isMiddleOfLine && !isValidMiddleOfLine) {
		return undefined;
	}

	return isMiddleOfLine && isValidMiddleOfLine;
}

/**
 * Checks if the position is valid inline suggestion position (middle of the line).
 * Returns `undefined` if it's position where ghost text shouldn't be displayed.
 */
export function isInlineSuggestion(document: CurrentDocument, position: Position): boolean | undefined {
	const lineIndex = position.lineNumber - 1; // Convert to 0-based
	const line = document.lines[lineIndex] ?? '';
	const textAfterCursor = line.substring(position.column - 1);
	return isInlineSuggestionFromTextAfterCursor(textAfterCursor);
}

/** Checks if there's non-whitespace text after cursor (i.e., NOT at end of line) */
function isMiddleOfTheLineFromTextAfterCursor(textAfterCursor: string): boolean {
	return textAfterCursor.trim().length !== 0;
}

/** Checks if text after cursor matches valid pattern for middle-of-line suggestions */
function isValidMiddleOfTheLineFromTextAfterCursor(textAfterCursor: string): boolean {
	const endOfLine = textAfterCursor.trim();
	return /^\s*[)>}\]"'`]*\s*[:{;,]?\s*$/.test(endOfLine);
}
