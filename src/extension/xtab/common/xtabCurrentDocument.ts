/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
		public readonly cursorPosition: Position,
	) {
		this.lines = content.getLines();
		this.transformer = content.getTransformer();
		this.cursorOffset = this.transformer.getOffset(cursorPosition);
		this.cursorLineOffset = this.cursorPosition.lineNumber - 1;
	}
}
