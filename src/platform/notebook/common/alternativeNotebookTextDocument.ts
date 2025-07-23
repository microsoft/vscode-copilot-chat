/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { NotebookCell, NotebookDocument, NotebookDocumentContentChange, TextDocument, TextDocumentContentChangeEvent, TextEditor } from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { findLastIdxMonotonous } from '../../../util/vs/base/common/arraysFind';
import { StringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { NotebookCellKind, Position, Range } from '../../../vscodeTypes';
import { stringEditFromTextContentChange } from '../../editing/common/edit';
import { PositionOffsetTransformer } from '../../editing/common/positionOffsetTransformer';
import { generateCellTextMarker, getBlockComment, getLineCommentStart } from './alternativeContentProvider.text';
import { EOL, summarize } from './helpers';
import { CrLfOffsetTranslator } from './offsetTranslator';


class AlternativeNotebookCellTextDocument {
	private readonly positionTransformer: PositionOffsetTransformer;
	private readonly crlfTranslator: CrLfOffsetTranslator;
	public readonly lineCount: number;
	public static fromNotebookCell(cell: NotebookCell, blockComment: [string, string], lineCommentStart: string): AlternativeNotebookCellTextDocument {
		const summary = summarize(cell);
		const cellMarker = generateCellTextMarker(summary, lineCommentStart);
		const code = cell.document.getText().replace(/\r\n|\n/g, EOL);
		const prefix = cell.kind === NotebookCellKind.Markup ? `${cellMarker}${EOL}${blockComment[0]}${EOL}` : `${cellMarker}${EOL}`;
		const suffix = cell.kind === NotebookCellKind.Markup ? `${EOL}${blockComment[1]}` : '';
		return new AlternativeNotebookCellTextDocument(cell, blockComment, lineCommentStart, code, prefix, suffix);
	}
	constructor(
		public readonly cell: NotebookCell,
		private readonly blockComment: [string, string],
		private readonly lineCommentStart: string,
		private readonly code: string,
		private readonly prefix: string,
		private readonly suffix: string
	) {
		this.crlfTranslator = new CrLfOffsetTranslator(cell.document.getText(), cell.document.eol);
		this.positionTransformer = new PositionOffsetTransformer(`${prefix}${code}${suffix}`);
		this.lineCount = this.positionTransformer.getLineCount();
	}

	public normalizeEdits(edits: readonly TextDocumentContentChangeEvent[]): TextDocumentContentChangeEvent[] {
		return edits.map(e => {
			const range = this.toAltRange(e.range);
			const rangeOffset = this.crlfTranslator.translate(e.rangeOffset);
			const endOffset = this.crlfTranslator.translate(e.rangeOffset + e.rangeLength);
			return {
				range,
				rangeLength: endOffset - rangeOffset,
				rangeOffset,
				text: e.text.replace(/\r\n|\n/g, EOL), // Normalize line endings to EOL
			};
		});
	}

	public withTextEdit(edit: StringEdit): AlternativeNotebookCellTextDocument {
		const newCode = edit.apply(this.code);
		return new AlternativeNotebookCellTextDocument(this.cell, this.blockComment, this.lineCommentStart, newCode, this.prefix, this.suffix);
	}

	public get altText(): string {
		return this.positionTransformer.getText();
	}

	public toAltOffsetRange(range: Range): OffsetRange {
		const startOffset = this.toAltOffset(range.start);
		const endOffset = this.toAltOffset(range.end);
		return new OffsetRange(startOffset, endOffset);
	}

	public toAltOffset(position: Position): number {
		// Remove the lines we've added for the cell marker and block comments
		const extraLinesAdded = this.cell.kind === NotebookCellKind.Markup ? 2 : 1;
		return this.positionTransformer.getOffset(new Position(position.line + extraLinesAdded, position.character));
	}

	public toAltRange(range: Range): Range {
		// Remove the lines we've added for the cell marker and block comments
		const extraLinesAdded = this.cell.kind === NotebookCellKind.Markup ? 2 : 1;
		return new Range(range.start.line + extraLinesAdded, range.start.character, range.end.line + extraLinesAdded, range.end.character);
	}

	public fromAltOffsetRange(offsetRange: OffsetRange): Range {
		const startOffset = offsetRange.start;
		const endOffset = offsetRange.endExclusive;
		const startPosition = this.positionTransformer.getPosition(startOffset);
		const endPosition = this.positionTransformer.getPosition(endOffset);

		// Remove the lines we've added for the cell marker and block comments
		const extraLinesAdded = this.cell.kind === NotebookCellKind.Markup ? 2 : 1;

		const startLine = Math.max(startPosition.line - extraLinesAdded, 0);
		const endLine = Math.max(endPosition.line - extraLinesAdded, 0);
		let endLineEndColumn = endPosition.character;
		if (endLine === (this.lineCount - extraLinesAdded)) {
			const lastPosition = this.positionTransformer.getPosition(this.positionTransformer.getText().length); // Ensure the transformer has the correct line count
			const lastLineLength = lastPosition.character;
			if (lastLineLength < endLineEndColumn) {
				endLineEndColumn = lastLineLength;
			}
		}
		return new Range(startLine, startPosition.character, endLine, endLineEndColumn);
	}
}

function cellsBuilder<T>(cellItems: T[], altCelBuilder: (cellItem: T) => AlternativeNotebookCellTextDocument, blockComment: [string, string], lineCommentStart: string) {
	let lineCount = 0;
	let offset = 0;
	return cellItems.map(item => {
		const altCell = altCelBuilder(item);
		const startLine = lineCount;
		const startOffset = offset;
		lineCount += altCell.lineCount;
		offset += altCell.altText.length + EOL.length; // EOL is added between cells
		return { altCell, startLine, startOffset };
	});
}

export class AlternativeNotebookTextDocument {
	private readonly cellTextDocuments = new Map<TextDocument, NotebookCell>();
	public static create(notebook: NotebookDocument) {
		return AlternativeNotebookTextDocument.createInstance(notebook, true);
	}

	private static createInstance(notebook: NotebookDocument, excludeMarkdownCells: boolean): AlternativeNotebookTextDocument {
		const blockComment = getBlockComment(notebook);
		const lineCommentStart = getLineCommentStart(notebook);
		const notebookCells = notebook.getCells().filter(cell => !excludeMarkdownCells || cell.kind !== NotebookCellKind.Markup);
		const altCells = cellsBuilder(notebookCells, cell => AlternativeNotebookCellTextDocument.fromNotebookCell(cell, blockComment, lineCommentStart), blockComment, lineCommentStart);

		return new AlternativeNotebookTextDocument(notebook, excludeMarkdownCells, blockComment, lineCommentStart, altCells);
	}
	public constructor(public readonly notebook: NotebookDocument,
		public readonly excludeMarkdownCells: boolean,
		private readonly blockComment: [string, string],
		private readonly lineCommentStart: string,
		public readonly altCells: { altCell: AlternativeNotebookCellTextDocument; startLine: number; startOffset: number }[]) {
		for (const { altCell } of this.altCells) {
			this.cellTextDocuments.set(altCell.cell.document, altCell.cell);
		}
	}

	public withNotebookChanges(events: readonly NotebookDocumentContentChange[]): AlternativeNotebookTextDocument {
		return withNotebookChangesAndEdit(this, events, this.excludeMarkdownCells)[0];
	}


	public withCellChanges(cellTextDoc: TextDocument, edit: StringEdit | readonly TextDocumentContentChangeEvent[]): AlternativeNotebookTextDocument {
		if (edit instanceof StringEdit ? edit.isEmpty() : edit.length === 0) {
			return this;
		}
		const cell = this.altCells.find(c => c.altCell.cell.document === cellTextDoc);
		if (!cell) {
			return this;
		}
		const cellEdit = edit instanceof StringEdit ? edit : stringEditFromTextContentChange(cell.altCell.normalizeEdits(edit));
		const blockComment = this.blockComment;
		const lineCommentStart = this.lineCommentStart;
		const altCells = cellsBuilder(this.altCells, cell => cell.altCell.cell.document === cellTextDoc ? cell.altCell.withTextEdit(cellEdit) : cell.altCell, blockComment, lineCommentStart);
		return new AlternativeNotebookTextDocument(this.notebook, this.excludeMarkdownCells, blockComment, lineCommentStart, altCells);
	}

	public getCell(textDocument: TextDocument): NotebookCell | undefined {
		return this.cellTextDocuments.get(textDocument);
	}

	public getText(range?: OffsetRange): string {
		const altText = this.altCells.map(cell => cell.altCell.altText).join(EOL);
		return range ? range.substring(altText) : altText;
	}

	public fromAltOffsetRange(offsetRange: OffsetRange): [NotebookCell, Range][] {
		const firstIdx = findLastIdxMonotonous(this.altCells, c => c.startOffset <= offsetRange.start);
		if (firstIdx === -1) {
			return [];
		}
		const cells: [NotebookCell, Range][] = [];

		for (let i = firstIdx; i < this.altCells.length; i++) {
			const { altCell, startOffset } = this.altCells[i];
			if (i === firstIdx) {
				const offset = new OffsetRange(offsetRange.start - startOffset, offsetRange.endExclusive - startOffset);
				cells.push([altCell.cell, altCell.fromAltOffsetRange(offset)]);
			} else if ((startOffset + altCell.altText.length) < offsetRange.endExclusive) {
				const offset = new OffsetRange(0, altCell.altText.length);
				cells.push([altCell.cell, altCell.fromAltOffsetRange(offset)]);
			} else if (startOffset < offsetRange.endExclusive) {
				const offset = new OffsetRange(0, offsetRange.endExclusive - startOffset);
				cells.push([altCell.cell, altCell.fromAltOffsetRange(offset)]);
			}
		}

		return cells;
	}

	public toAltOffset(cell: NotebookCell, position: Position): number | undefined {
		const altCell = this.altCells.find(c => c.altCell.cell === cell);
		if (altCell) {
			return altCell.altCell.toAltOffset(position);
		} else {
			return undefined;
		}
	}

	public toAltOffsetRange(cell: NotebookCell, ranges: readonly Range[]): OffsetRange[] {
		let offset = 0;
		for (const { altCell } of this.altCells) {
			if (altCell.cell === cell) {
				return ranges.map(range => {
					const offsetRange = altCell.toAltOffsetRange(range);
					const adjustedRange = new OffsetRange(offset + offsetRange.start, offset + offsetRange.endExclusive);
					return adjustedRange;
				});
			} else {
				offset += altCell.altText.length + EOL.length; // EOL is added between cells
			}
		}
		return [];
	}

	public toAltRange(cell: NotebookCell, ranges: readonly Range[]): Range[] {
		let offset = 0;
		for (const { altCell, startLine } of this.altCells) {
			if (altCell.cell === cell) {
				return ranges.map(range => {
					const altCellRange = altCell.toAltRange(range);
					const adjustedRange = new Range(altCellRange.start.line + startLine, altCellRange.start.character, altCellRange.end.line + startLine, altCellRange.end.character);
					return adjustedRange;
				});
			} else {
				offset += altCell.altText.length + EOL.length; // EOL is added between cells
			}
		}
		return [];
	}
}

function withNotebookChangesAndEdit(altDoc: AlternativeNotebookTextDocument, events: readonly NotebookDocumentContentChange[], excludeMarkdownCells: boolean): [AlternativeNotebookTextDocument, StringEdit | undefined] {
	if (!events.length) {
		return [altDoc, undefined];
	}
	// If we've only added md cells, then its a noop.
	if (events.every(e => e.removedCells.length === 0 && e.addedCells.every(c => c.kind === NotebookCellKind.Markup))) {
		return [altDoc, undefined];
	}
	let altCells = altDoc.altCells.slice();
	let edit = StringEdit.empty;
	const blockComment = getBlockComment(altDoc.notebook);
	const lineCommentStart = getLineCommentStart(altDoc.notebook);
	for (const event of events) {
		const newCells = event.addedCells.filter(c => excludeMarkdownCells ? c.kind === NotebookCellKind.Code : true).map(cell => ({ altCell: AlternativeNotebookCellTextDocument.fromNotebookCell(cell, blockComment, lineCommentStart), startLine: 0, startOffset: 0 }));

		const removedCells = altCells.slice(event.range.start, event.range.end);
		let firstUnChangedCellIndex = -1;
		if (event.range.isEmpty) {
			firstUnChangedCellIndex = event.range.start === 0 ? -1 : event.range.start - 1;
		} else {
			firstUnChangedCellIndex = event.range.start === 0 ? -1 : event.range.start - 1;
		}
		const startOffset = firstUnChangedCellIndex === -1 ? 0 : altCells[firstUnChangedCellIndex].startOffset + altCells[firstUnChangedCellIndex].altCell.altText.length + EOL.length;
		let offsetLength = removedCells.map((cell) => cell.altCell.altText).join(EOL).length;
		let newCellsContent = newCells.map((cell) => cell.altCell.altText).join(EOL);
		if (startOffset !== 0) {
			if (!(event.range.end < altCells.length)) {
				newCellsContent = `${EOL}${newCellsContent}`;
			}
		}
		// if we have some cells after the insertion, then we need to insert an EOL at the end.
		if (event.range.end < altCells.length) {
			if (newCellsContent) {
				newCellsContent += EOL;
			}
			if (offsetLength) {
				offsetLength += EOL.length;
			}
		}
		edit = edit.compose(StringEdit.replace(new OffsetRange(startOffset, startOffset + offsetLength), newCellsContent));

		altCells.splice(event.range.start, event.range.end - event.range.start, ...newCells);
		altCells = cellsBuilder(altCells, cell => cell.altCell, blockComment, lineCommentStart);
	}

	altDoc = new AlternativeNotebookTextDocument(altDoc.notebook, altDoc.excludeMarkdownCells, blockComment, lineCommentStart, altCells);
	return [altDoc, edit];
}

export function editFromNotebookCellTextDocumentContentChangeEvents(notebook: AlternativeNotebookTextDocument, cellTextDocument: TextDocument, events: readonly TextDocumentContentChangeEvent[]): StringEdit {
	const replacementsInApplicationOrder = toAltCellTextDocumentContentChangeEvents(notebook, cellTextDocument, events);
	return stringEditFromTextContentChange(replacementsInApplicationOrder);
}

export function editFromNotebookChangeEvents(notebook: AlternativeNotebookTextDocument, events: readonly NotebookDocumentContentChange[]): StringEdit | undefined {
	return withNotebookChangesAndEdit(notebook, events, notebook.excludeMarkdownCells)[1];
}

export function toAltCellTextDocumentContentChangeEvents(notebook: AlternativeNotebookTextDocument, cellTextDocument: TextDocument, events: readonly TextDocumentContentChangeEvent[]): TextDocumentContentChangeEvent[] {
	return coalesce(events.map(e => {
		const cell = notebook.getCell(cellTextDocument);
		if (!cell) {
			return undefined;
		}
		const ranges = notebook.toAltRange(cell, [e.range]);
		const rangeOffsets = notebook.toAltOffsetRange(cell, [e.range]);
		if (!ranges.length || !rangeOffsets.length) {
			return undefined;
		}
		const range = ranges[0];
		const rangeOffset = rangeOffsets[0];
		return {
			range,
			rangeLength: rangeOffset.endExclusive - rangeOffset.start,
			rangeOffset: rangeOffset.start,
			text: e.text.replace(/\r\n|\n/g, EOL), // Normalize line endings to EOL
		} as typeof e;
	}));
}

export function fromAltTextDocumentContentChangeEvents(notebook: AlternativeNotebookTextDocument, events: readonly TextDocumentContentChangeEvent[]): [NotebookCell, TextDocumentContentChangeEvent[]][] {
	if (!events.length) {
		return [];
	}

	// Map to collect changes per cell
	const cellChanges = new Map<NotebookCell, TextDocumentContentChangeEvent[]>();

	for (const event of events) {
		const altRange = new OffsetRange(event.rangeOffset, event.rangeOffset + event.rangeLength);
		const cellRanges = notebook.fromAltOffsetRange(altRange);

		if (!cellRanges?.length) {
			continue;
		}

		// Handle the case where a single alt document change affects multiple cells
		let textOffset = 0;
		const eventText = event.text;

		for (let i = 0; i < cellRanges.length; i++) {
			const [cell, cellRange] = cellRanges[i];

			// Calculate the portion of the text that applies to this cell
			let cellText = '';
			if (cellRanges.length === 1) {
				// Single cell case - use entire text
				cellText = eventText;
			} else if (i === cellRanges.length - 1) {
				// Last cell in multi-cell change
				cellText = eventText.substring(textOffset);
			} else {
				// First or middle cell in multi-cell change
				// For simplicity, split text evenly or use line breaks as boundaries
				const remainingText = eventText.substring(textOffset);
				const nextLineBreak = remainingText.indexOf(EOL);
				if (nextLineBreak !== -1) {
					cellText = remainingText.substring(0, nextLineBreak + EOL.length);
					textOffset += cellText.length;
				} else {
					cellText = remainingText;
					textOffset = eventText.length;
				}
			}

			// Convert EOL back to cell's line ending format
			const cellEol = cell.document.eol === 2 ? '\r\n' : '\n'; // EndOfLine.CRLF = 2, EndOfLine.LF = 1
			const convertedText = cellText.replace(new RegExp(EOL, 'g'), cellEol);

			// Calculate rangeOffset for the cell
			const cellDoc = cell.document;
			let rangeOffset = 0;
			for (let line = 0; line < cellRange.start.line; line++) {
				rangeOffset += cellDoc.lineAt(line).text.length + (cellDoc.eol === 2 ? 2 : 1);
			}
			rangeOffset += cellRange.start.character;

			// Calculate rangeLength for the cell
			let rangeLength = 0;
			if (cellRange.start.line === cellRange.end.line) {
				rangeLength = cellRange.end.character - cellRange.start.character;
			} else {
				// Multi-line range
				rangeLength = cellDoc.lineAt(cellRange.start.line).text.length - cellRange.start.character + (cellDoc.eol === 2 ? 2 : 1);
				for (let line = cellRange.start.line + 1; line < cellRange.end.line; line++) {
					rangeLength += cellDoc.lineAt(line).text.length + (cellDoc.eol === 2 ? 2 : 1);
				}
				rangeLength += cellRange.end.character;
			}

			// Create the cell-specific change event
			const cellChangeEvent: TextDocumentContentChangeEvent = {
				range: cellRange,
				rangeLength: rangeLength,
				rangeOffset: rangeOffset,
				text: convertedText
			};

			// Add to the map
			if (!cellChanges.has(cell)) {
				cellChanges.set(cell, []);
			}
			cellChanges.get(cell)!.push(cellChangeEvent);
		}
	}

	return Array.from(cellChanges.entries());
}

export function projectVisibleRanges(altNotebook: AlternativeNotebookTextDocument, visibleTextEditors: readonly TextEditor[]): OffsetRange[] {
	const visibleEditors = new Map(visibleTextEditors.map(editor => ([editor.document, editor] as const)));
	const visibleCells = altNotebook.notebook.getCells().filter(cell => visibleEditors.has(cell.document));
	return visibleCells.flatMap(cell => {
		const editor = visibleEditors.get(cell.document);
		if (editor) {
			return altNotebook.toAltOffsetRange(cell, editor.visibleRanges);
		}
		return [];
	});
}

