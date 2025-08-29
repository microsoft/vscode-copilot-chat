/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { StatelessNextEditDocument } from './statelessNextEditProvider';

export class IgnoreEmptyLineAndLeadingTrailingWhitespaceChanges {
	public static filterEdit(resultDocument: StatelessNextEditDocument, singleEdits: readonly LineReplacement[]): readonly LineReplacement[] {
		const filteredEdits = singleEdits.filter(e => !IgnoreEmptyLineAndLeadingTrailingWhitespaceChanges._isWhitespaceOnlyChange(e, resultDocument.documentAfterEditsLines));
		return filteredEdits;
	}

	private static _isWhitespaceOnlyChange(edit: LineReplacement, baseLines: string[]): boolean {
		const originalLines = edit.lineRange.toOffsetRange().slice(baseLines);
		const newLines = edit.newLines;

		const isRemoval = newLines.length === 0;

		// is removing empty lines
		if (isRemoval && originalLines.every(line => line.trim() === '')) {
			return true;
		}

		// is adding empty lines
		if (!isRemoval && newLines.every(line => line.trim() === '')) {
			return true;
		}

		if (originalLines.length !== newLines.length) {
			return false;
		}

		for (let i = 0; i < originalLines.length; i++) {
			const originalLine = originalLines[i];
			const newLine = newLines[i];
			if (originalLine.trim() !== newLine.trim()) {
				return false;
			}
		}
		return true;
	}
}

export class IgnoreWhitespaceOnlyChanges {
	public static filterEdit(resultDocument: StatelessNextEditDocument, singleEdits: readonly LineReplacement[]): readonly LineReplacement[] {
		return singleEdits.filter(e => !IgnoreWhitespaceOnlyChanges._isFormattingOnlyChange(resultDocument.documentAfterEditsLines, e));
	}

	/**
	 * @remarks public only for testing
	 */
	public static _isFormattingOnlyChange(baseLines: string[], singleEdit: LineReplacement): boolean {
		const originalLines = singleEdit.lineRange.toOffsetRange().slice(baseLines).join('').replace(/\s/g, '');
		const newLines = singleEdit.newLines.join('').replace(/\s/g, '');
		return originalLines === newLines;
	}
}
