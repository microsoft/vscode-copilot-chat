/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI as Uri } from '../../../vs/base/common/uri';
import { ensureValidWordDefinition, getWordAtText } from '../../../vs/editor/common/core/wordHelper';
import { EndOfLine } from './enums';
import { Position } from './position';
import { PrefixSumComputer } from './prefixSumComputer';
import { Range } from './range';

export interface TextLine {
	readonly lineNumber: number;
	readonly text: string;
	readonly range: Range;
	readonly rangeIncludingLineBreak: Range;
	readonly firstNonWhitespaceCharacterIndex: number;
	readonly isEmptyOrWhitespace: boolean;
}

export interface TextDocument {
	readonly uri: Uri;
	readonly fileName: string;
	readonly isUntitled: boolean;
	readonly languageId: string;
	readonly version: number;
	readonly isDirty: boolean;
	readonly isClosed: boolean;
	// save(): Promise<boolean>;
	readonly eol: EndOfLine;
	readonly lineCount: number;
	lineAt(line: number): TextLine;
	lineAt(position: Position): TextLine;
	offsetAt(position: Position): number;
	positionAt(offset: number): Position;
	getText(range?: Range): string;
	getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined;
	validateRange(range: Range): Range;
	validatePosition(position: Position): Position;
}

interface IPosition {
	lineNumber: number;
	column: number;
}

interface IRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export interface IModelContentChangedEvent {
	readonly range: IRange;
	readonly text: string;
}

export interface IModelChangedEvent {
	readonly changes: IModelContentChangedEvent[];
	readonly eol?: string | undefined;
	readonly versionId: number;
}

export function regExpLeadsToEndlessLoop(regexp: RegExp): boolean {
	// Exit early if it's one of these special cases which are meant to match
	// against an empty string
	if (regexp.source === '^' || regexp.source === '^$' || regexp.source === '$' || regexp.source === '^\\s*$') {
		return false;
	}

	// We check against an empty string. If the regular expression doesn't advance
	// (e.g. ends in an endless loop) it will match an empty string.
	const match = regexp.exec('');
	return !!(match && regexp.lastIndex === 0);
}

export function splitLines(str: string): string[] {
	return str.split(/\r\n|\r|\n/);
}

class MirrorTextModel {
	protected _uri: Uri;
	protected _lines: string[];
	protected _eol: string;
	protected _versionId: number;
	protected _lineStarts: PrefixSumComputer | null;
	private _cachedTextValue: string | null;

	constructor(uri: Uri, lines: string[], eol: string, versionId: number) {
		this._uri = uri;
		this._lines = lines;
		this._eol = eol;
		this._versionId = versionId;
		this._lineStarts = null;
		this._cachedTextValue = null;
	}

	dispose(): void {
		this._lines.length = 0;
	}

	get version(): number {
		return this._versionId;
	}

	getText(): string {
		if (this._cachedTextValue === null) {
			this._cachedTextValue = this._lines.join(this._eol);
		}
		return this._cachedTextValue;
	}

	onEvents(e: IModelChangedEvent): void {
		if (e.eol && e.eol !== this._eol) {
			this._eol = e.eol;
			this._lineStarts = null;
		}

		// Update my lines
		const changes = e.changes;
		for (const change of changes) {
			this._acceptDeleteRange(change.range);
			this._acceptInsertText(
				{ lineNumber: change.range.startLineNumber, column: change.range.startColumn },
				change.text
			);
		}

		this._versionId = e.versionId;
		this._cachedTextValue = null;
	}

	protected _ensureLineStarts(): void {
		if (!this._lineStarts) {
			const eolLength = this._eol.length;
			const linesLength = this._lines.length;
			const lineStartValues = new Uint32Array(linesLength);
			for (let i = 0; i < linesLength; i++) {
				lineStartValues[i] = this._lines[i].length + eolLength;
			}
			this._lineStarts = new PrefixSumComputer(lineStartValues);
		}
	}

	/**
	 * All changes to a line's text go through this method
	 */
	private _setLineText(lineIndex: number, newValue: string): void {
		this._lines[lineIndex] = newValue;
		if (this._lineStarts) {
			// update prefix sum
			this._lineStarts.setValue(lineIndex, this._lines[lineIndex].length + this._eol.length);
		}
	}

	private _acceptDeleteRange(range: IRange): void {
		if (range.startLineNumber === range.endLineNumber) {
			if (range.startColumn === range.endColumn) {
				// Nothing to delete
				return;
			}
			// Delete text on the affected line
			this._setLineText(
				range.startLineNumber - 1,
				this._lines[range.startLineNumber - 1].substring(0, range.startColumn - 1) +
				this._lines[range.startLineNumber - 1].substring(range.endColumn - 1)
			);
			return;
		}

		// Take remaining text on last line and append it to remaining text on first line
		this._setLineText(
			range.startLineNumber - 1,
			this._lines[range.startLineNumber - 1].substring(0, range.startColumn - 1) +
			this._lines[range.endLineNumber - 1].substring(range.endColumn - 1)
		);

		// Delete middle lines
		this._lines.splice(range.startLineNumber, range.endLineNumber - range.startLineNumber);
		if (this._lineStarts) {
			// update prefix sum
			this._lineStarts.removeValues(range.startLineNumber, range.endLineNumber - range.startLineNumber);
		}
	}

	private _acceptInsertText(position: IPosition, insertText: string): void {
		if (insertText.length === 0) {
			// Nothing to insert
			return;
		}
		const insertLines = splitLines(insertText);
		if (insertLines.length === 1) {
			// Inserting text on one line
			this._setLineText(
				position.lineNumber - 1,
				this._lines[position.lineNumber - 1].substring(0, position.column - 1) +
				insertLines[0] +
				this._lines[position.lineNumber - 1].substring(position.column - 1)
			);
			return;
		}

		// Append overflowing text from first line to the end of text to insert
		insertLines[insertLines.length - 1] += this._lines[position.lineNumber - 1].substring(position.column - 1);

		// Delete overflowing text from first line and insert text on first line
		this._setLineText(
			position.lineNumber - 1,
			this._lines[position.lineNumber - 1].substring(0, position.column - 1) + insertLines[0]
		);

		// Insert new lines & store lengths
		const newLengths = new Uint32Array(insertLines.length - 1);
		for (let i = 1; i < insertLines.length; i++) {
			this._lines.splice(position.lineNumber + i - 1, 0, insertLines[i]);
			newLengths[i - 1] = insertLines[i].length + this._eol.length;
		}

		if (this._lineStarts) {
			// update prefix sum
			this._lineStarts.insertValues(position.lineNumber, newLengths);
		}
	}
}

const _languageId2WordDefinition = new Map<string, RegExp>();
export function setWordDefinitionFor(languageId: string, wordDefinition: RegExp | undefined): void {
	if (!wordDefinition) {
		_languageId2WordDefinition.delete(languageId);
	} else {
		_languageId2WordDefinition.set(languageId, wordDefinition);
	}
}

function getWordDefinitionFor(languageId: string): RegExp | undefined {
	return _languageId2WordDefinition.get(languageId);
}

export class ExtHostDocumentData extends MirrorTextModel {
	public static create(uri: Uri, contents: string, languageId: string): ExtHostDocumentData {
		const lines = splitLines(contents);
		const eol = contents.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
		return new ExtHostDocumentData(uri, lines, eol, 1, languageId, false);
	}

	private _document?: TextDocument;
	private _isDisposed = false;

	constructor(
		uri: Uri,
		lines: string[],
		eol: string,
		versionId: number,
		private _languageId: string,
		private _isDirty: boolean
	) {
		super(uri, lines, eol, versionId);
	}

	override dispose(): void {
		// we don't really dispose documents but let
		// extensions still read from them. some
		// operations, live saving, will now error tho
		this._isDisposed = true;
		this._isDirty = false;
	}

	// equalLines(lines: readonly string[]): boolean {
	// 	return equals(this._lines, lines);
	// }

	get document(): vscode.TextDocument {
		if (!this._document) {
			const that = this;
			this._document = {
				get uri() {
					return that._uri;
				},
				get fileName() {
					return that._uri.fsPath;
				},
				get isUntitled() {
					return that._uri.scheme === 'untitled';
				},
				get languageId() {
					return that._languageId;
				},
				get version() {
					return that._versionId;
				},
				get isClosed() {
					return that._isDisposed;
				},
				get isDirty() {
					return that._isDirty;
				},
				// save() { return that._save(); },
				getText(range?) {
					return range ? that._getTextInRange(range) : that.getText();
				},
				get eol() {
					return that._eol === '\n' ? EndOfLine.LF : EndOfLine.CRLF;
				},
				get lineCount() {
					return that._lines.length;
				},
				lineAt(lineOrPos: number | Position) {
					return that._lineAt(lineOrPos);
				},
				offsetAt(pos) {
					return that._offsetAt(pos);
				},
				positionAt(offset) {
					return that._positionAt(offset);
				},
				validateRange(ran) {
					return that._validateRange(ran);
				},
				validatePosition(pos) {
					return that._validatePosition(pos);
				},
				getWordRangeAtPosition(pos, regexp?) { return that._getWordRangeAtPosition(pos, regexp); },
			};
		}
		return Object.freeze(this._document) as any as vscode.TextDocument;
	}

	_acceptLanguageId(newLanguageId: string): void {
		// ok(!this._isDisposed);
		this._languageId = newLanguageId;
	}

	_acceptIsDirty(isDirty: boolean): void {
		// ok(!this._isDisposed);
		this._isDirty = isDirty;
	}

	// private _save(): Promise<boolean> {
	// 	if (this._isDisposed) {
	// 		return Promise.reject(new Error('Document has been closed'));
	// 	}
	// 	return this._proxy.$trySaveDocument(this._uri);
	// }

	private _getTextInRange(_range: Range): string {
		const range = this._validateRange(_range);

		if (range.isEmpty) {
			return '';
		}

		if (range.isSingleLine) {
			return this._lines[range.start.line].substring(range.start.character, range.end.character);
		}

		const lineEnding = this._eol,
			startLineIndex = range.start.line,
			endLineIndex = range.end.line,
			resultLines: string[] = [];

		resultLines.push(this._lines[startLineIndex].substring(range.start.character));
		for (let i = startLineIndex + 1; i < endLineIndex; i++) {
			resultLines.push(this._lines[i]);
		}
		resultLines.push(this._lines[endLineIndex].substring(0, range.end.character));

		return resultLines.join(lineEnding);
	}

	private _lineAt(lineOrPosition: number | Position): TextLine {
		let line: number | undefined;
		if (lineOrPosition instanceof Position) {
			line = lineOrPosition.line;
		} else if (typeof lineOrPosition === 'number') {
			line = lineOrPosition;
		}

		if (typeof line !== 'number' || line < 0 || line >= this._lines.length || Math.floor(line) !== line) {
			throw new Error('Illegal value for `line`');
		}

		return new ExtHostDocumentLine(line, this._lines[line], line === this._lines.length - 1);
	}

	private _offsetAt(position: Position): number {
		position = this._validatePosition(position);
		this._ensureLineStarts();
		return this._lineStarts!.getPrefixSum(position.line - 1) + position.character;
	}

	private _positionAt(offset: number): Position {
		offset = Math.floor(offset);
		offset = Math.max(0, offset);

		this._ensureLineStarts();
		const out = this._lineStarts!.getIndexOf(offset);

		const lineLength = this._lines[out.index].length;

		// Ensure we return a valid position
		return new Position(out.index, Math.min(out.remainder, lineLength));
	}

	// ---- range math

	private _validateRange(range: Range): Range {
		if (!Range.isRange(range)) {
			throw new Error('Invalid argument');
		}

		const start = this._validatePosition(range.start);
		const end = this._validatePosition(range.end);

		if (start === range.start && end === range.end) {
			return range;
		}
		return new Range(start.line, start.character, end.line, end.character);
	}

	private _validatePosition(position: Position): Position {
		if (!Position.isPosition(position)) {
			throw new Error('Invalid argument');
		}

		if (this._lines.length === 0) {
			return position.with(0, 0);
		}

		let { line, character } = position;
		let hasChanged = false;

		if (line < 0) {
			line = 0;
			character = 0;
			hasChanged = true;
		} else if (line >= this._lines.length) {
			line = this._lines.length - 1;
			character = this._lines[line].length;
			hasChanged = true;
		} else {
			const maxCharacter = this._lines[line].length;
			if (character < 0) {
				character = 0;
				hasChanged = true;
			} else if (character > maxCharacter) {
				character = maxCharacter;
				hasChanged = true;
			}
		}

		if (!hasChanged) {
			return position;
		}
		return new Position(line, character);
	}

	private _getWordRangeAtPosition(_position: Position, regexp?: RegExp): Range | undefined {
		const position = this._validatePosition(_position);

		if (!regexp) {
			// use default when custom-regexp isn't provided
			regexp = getWordDefinitionFor(this._languageId);

		} else if (regExpLeadsToEndlessLoop(regexp)) {
			// use default when custom-regexp is bad
			throw new Error(`[getWordRangeAtPosition]: ignoring custom regexp '${regexp.source}' because it matches the empty string.`);
		}

		const wordAtText = getWordAtText(
			position.character + 1,
			ensureValidWordDefinition(regexp),
			this._lines[position.line],
			0
		);

		if (wordAtText) {
			return new Range(position.line, wordAtText.startColumn - 1, position.line, wordAtText.endColumn - 1);
		}
		return undefined;
	}
}

export class ExtHostDocumentLine implements TextLine {
	private readonly _line: number;
	private readonly _text: string;
	private readonly _isLastLine: boolean;

	constructor(line: number, text: string, isLastLine: boolean) {
		this._line = line;
		this._text = text;
		this._isLastLine = isLastLine;
	}

	public get lineNumber(): number {
		return this._line;
	}

	public get text(): string {
		return this._text;
	}

	public get range(): Range {
		return new Range(this._line, 0, this._line, this._text.length);
	}

	public get rangeIncludingLineBreak(): Range {
		if (this._isLastLine) {
			return this.range;
		}
		return new Range(this._line, 0, this._line + 1, 0);
	}

	public get firstNonWhitespaceCharacterIndex(): number {
		//TODO@api, rename to 'leadingWhitespaceLength'
		return /^(\s*)/.exec(this._text)![1].length;
	}

	public get isEmptyOrWhitespace(): boolean {
		return this.firstNonWhitespaceCharacterIndex === this._text.length;
	}
}
