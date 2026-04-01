/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BugIndicatingError } from '../../../util/vs/base/common/errors';
import { Position } from '../../../util/vs/editor/common/core/position';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { PositionOffsetTransformer } from '../../../util/vs/editor/common/core/text/positionToOffsetImpl';

export class CurrentDocument {

	public readonly lines: string[];
	public readonly cursorOffset: number;

	public readonly transformer: PositionOffsetTransformer;

	/**
	 * The 0-based line number of the cursor.
	 */
	public readonly cursorLineOffset: number;

	constructor(
		public readonly content: StringText,
		/** Note that `cursorPosition`'s line and column numbers are 1-based. */
		public readonly cursorPosition: Position,
	) {
		this.lines = content.getLines();
		this.transformer = content.getTransformer();
		this.cursorOffset = this.transformer.getOffset(cursorPosition);
		this.cursorLineOffset = this.cursorPosition.lineNumber - 1;
	}

	/** Returns the full text of the line containing the cursor. */
	lineWithCursor(): string {
		const line = this.lines.at(this.cursorLineOffset);
		if (line === undefined) {
			throw new BugIndicatingError(`CurrentDocument#lineWithCursor: cursor is out of bounds: cursor: ${this.cursorLineOffset}, doc line count: ${this.lines.length}`);
		}
		return line;
	}

	textAfterCursor(): string {
		const line = this.lineWithCursor();
		return line.substring(this.cursorPosition.column - 1);
	}

	/**
	 * Determines if the cursor is at the end of the line.
	 */
	isCursorAtEndOfLine(): boolean {
		// checks if there's any non-whitespace character after the cursor in the line
		const afterCursor = this.textAfterCursor();
		const isAtEndOfLine = afterCursor.match(/^\s*$/) !== null;
		return isAtEndOfLine;
	}
}
