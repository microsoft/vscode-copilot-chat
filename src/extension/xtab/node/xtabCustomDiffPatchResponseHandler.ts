/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NoNextEditReason, StreamedEdit } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { fromUnknown } from '../../../util/common/errors';
import { LineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { LineRange } from '../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { ResponseTags } from '../common/tags';


class Patch {
	public removedLines: string[] = [];
	public addedLines: string[] = [];

	private constructor(
		public readonly filename: string,
		public readonly lineNumZeroBased: number,
	) { }

	public static ofLine(line: string): Patch | null {
		const match = line.match(/^(.+):(\d+)$/);
		if (!match) {
			return null;
		}
		const [, filename, lineNumber] = match;
		return new Patch(filename, parseInt(lineNumber, 10));
	}

	addLine(line: string) {
		const contentLine = line.slice(1);
		if (line.startsWith('-')) {
			this.removedLines.push(contentLine);
			return true;
		} else if (line.startsWith('+')) {
			this.addedLines.push(contentLine);
			return true;
		} else {
			return false;
		}
	}

	public toString(): string {
		return [
			`${this.filename}:${this.lineNumZeroBased}`,
			...this.removedLines.map(l => `-${l}`),
			...this.addedLines.map(l => `+${l}`),
		].join('\n');
	}
}


export class XtabCustomDiffPatchResponseHandler {

	public static async *handleResponse(
		linesStream: AsyncIterable<string>,
		documentBeforeEdits: StringText,
		window: OffsetRange | undefined,
		originalWindow?: OffsetRange,
	): AsyncGenerator<StreamedEdit, NoNextEditReason, void> {
		try {
			for await (const edit of XtabCustomDiffPatchResponseHandler.extractEdits(linesStream)) {
				yield {
					edit: XtabCustomDiffPatchResponseHandler.resolveEdit(edit),
					window,
					originalWindow,
					isFromCursorJump: true,
					// targetDocument, // TODO@ulugbekna: implement target document resolution
				} satisfies StreamedEdit;
			}
		} catch (e: unknown) {
			const err = fromUnknown(e);
			return new NoNextEditReason.Unexpected(err);
		}

		return new NoNextEditReason.NoSuggestions(documentBeforeEdits, window, undefined);
	}

	private static resolveEdit(patch: Patch): LineReplacement {
		return new LineReplacement(new LineRange(patch.lineNumZeroBased + 1, patch.lineNumZeroBased + 1 + patch.removedLines.length), patch.addedLines);
	}

	public static async *extractEdits(linesStream: AsyncIterable<string>): AsyncGenerator<Patch> {
		let currentPatch: Patch | null = null;
		for await (const line of linesStream) {
			// if no current patch, try to parse a new one
			if (line.trim() === ResponseTags.NO_EDIT) {
				break;
			}
			if (currentPatch === null) {
				currentPatch = Patch.ofLine(line);
				continue;
			}
			// try to add line to current patch
			if (currentPatch.addLine(line)) {
				continue;
			} else { // line does not belong to current patch, yield current and start new
				if (currentPatch) {
					yield currentPatch;
				}
				currentPatch = Patch.ofLine(line);
			}
		}
		if (currentPatch) {
			yield currentPatch;
		}
	}
}
