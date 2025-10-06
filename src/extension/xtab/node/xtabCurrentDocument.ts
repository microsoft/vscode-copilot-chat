/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../util/vs/editor/common/core/position';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';

export class CurrentDocument {

	public readonly lines: Lazy<string[]>;
	public readonly cursorOffset: number;

	/**
	 * The 0-based line number of the cursor.
	 */
	public readonly cursorLineOffset: number;

	constructor(
		public readonly content: StringText,
		public readonly cursorPosition: Position,
	) {
		this.lines = new Lazy(() => content.getLines());
		this.cursorOffset = content.getTransformer().getOffset(cursorPosition);
		this.cursorLineOffset = this.cursorPosition.lineNumber - 1;
	}
}
