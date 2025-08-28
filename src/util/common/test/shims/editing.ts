/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { coalesceInPlace } from '../../../vs/base/common/arrays';
import { illegalArgument } from '../../../vs/base/common/errors';
import { ResourceMap } from '../../../vs/base/common/map';
import { URI as Uri } from '../../../vs/base/common/uri';
import { EndOfLine } from './enums';
import { Position } from './position';
import { Range } from './range';

export class TextEdit {

	__vscodeBrand: undefined;

	static isTextEdit(thing: any): thing is TextEdit {
		if (thing instanceof TextEdit) {
			return true;
		}
		if (!thing) {
			return false;
		}
		return Range.isRange(<TextEdit>thing) && typeof (<TextEdit>thing).newText === 'string';
	}

	static replace(range: Range, newText: string): TextEdit {
		return new TextEdit(range, newText);
	}

	static insert(position: Position, newText: string): TextEdit {
		return TextEdit.replace(new Range(position, position), newText);
	}

	static delete(range: Range): TextEdit {
		return TextEdit.replace(range, '');
	}

	static setEndOfLine(eol: EndOfLine): TextEdit {
		const ret = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
		ret.newEol = eol;
		return ret;
	}

	protected _range: Range;
	protected _newText: string | null;
	protected _newEol?: EndOfLine;

	get range(): Range {
		return this._range;
	}

	set range(value: Range) {
		if (value && !Range.isRange(value)) {
			throw illegalArgument('range');
		}
		this._range = value;
	}

	get newText(): string {
		return this._newText || '';
	}

	set newText(value: string) {
		if (value && typeof value !== 'string') {
			throw illegalArgument('newText');
		}
		this._newText = value;
	}

	get newEol(): EndOfLine | undefined {
		return this._newEol;
	}

	set newEol(value: EndOfLine | undefined) {
		if (value && typeof value !== 'number') {
			throw illegalArgument('newEol');
		}
		this._newEol = value;
	}

	constructor(range: Range, newText: string | null) {
		this._range = range;
		this._newText = newText;
	}

	toJSON(): any {
		return {
			range: this.range,
			newText: this.newText,
			newEol: this._newEol,
		};
	}
}

export class SnippetString {
	static isSnippetString(thing: any): thing is SnippetString {
		if (thing instanceof SnippetString) {
			return true;
		}
		if (!thing) {
			return false;
		}
		return typeof (<SnippetString>thing).value === 'string';
	}

	private static _escape(value: string): string {
		return value.replace(/\$|}|\\/g, '\\$&');
	}

	private _tabstop = 1;

	value: string;

	constructor(value?: string) {
		this.value = value || '';
	}

	appendText(string: string): SnippetString {
		this.value += SnippetString._escape(string);
		return this;
	}

	appendTabstop(number: number = this._tabstop++): SnippetString {
		this.value += '$';
		this.value += number;
		return this;
	}

	appendPlaceholder(
		value: string | ((snippet: SnippetString) => any),
		number: number = this._tabstop++
	): SnippetString {
		if (typeof value === 'function') {
			const nested = new SnippetString();
			nested._tabstop = this._tabstop;
			value(nested);
			this._tabstop = nested._tabstop;
			value = nested.value;
		} else {
			value = SnippetString._escape(value);
		}

		this.value += '${';
		this.value += number;
		this.value += ':';
		this.value += value;
		this.value += '}';

		return this;
	}

	appendChoice(values: string[], number: number = this._tabstop++): SnippetString {
		const value = values.map(s => s.replace(/\$|}|\\|,/g, '\\$&')).join(',');

		this.value += '${';
		this.value += number;
		this.value += '|';
		this.value += value;
		this.value += '|}';

		return this;
	}

	appendVariable(name: string, defaultValue?: string | ((snippet: SnippetString) => any)): SnippetString {
		if (typeof defaultValue === 'function') {
			const nested = new SnippetString();
			nested._tabstop = this._tabstop;
			defaultValue(nested);
			this._tabstop = nested._tabstop;
			defaultValue = nested.value;
		} else if (typeof defaultValue === 'string') {
			defaultValue = defaultValue.replace(/\$|}/g, '\\$&'); // CodeQL [SM02383] I do not want to escape backslashes here
		}

		this.value += '${';
		this.value += name;
		if (defaultValue) {
			this.value += ':';
			this.value += defaultValue;
		}
		this.value += '}';

		return this;
	}
}

export interface WorkspaceEditEntryMetadata {
	needsConfirmation: boolean;
	label: string;
	description?: string;
	// iconPath?: Uri | { light: Uri; dark: Uri } | ThemeIcon;
}

export interface IFileOperationOptions {
	readonly overwrite?: boolean;
	readonly ignoreIfExists?: boolean;
	readonly ignoreIfNotExists?: boolean;
	readonly recursive?: boolean;
	readonly contents?: Uint8Array;
}

export const enum FileEditType {
	File = 1,
	Text = 2,
	Cell = 3,
	CellReplace = 5,
	Snippet = 6,
}

export interface IFileOperation {
	readonly _type: FileEditType.File;
	readonly from?: Uri;
	readonly to?: Uri;
	readonly options?: IFileOperationOptions;
	readonly metadata?: WorkspaceEditEntryMetadata;
}

export interface IFileTextEdit {
	readonly _type: FileEditType.Text;
	readonly uri: Uri;
	readonly edit: TextEdit;
	readonly metadata?: WorkspaceEditEntryMetadata;
}

export interface IFileSnippetTextEdit {
	readonly _type: FileEditType.Snippet;
	readonly uri: Uri;
	readonly range: Range;
	readonly edit: SnippetString;
	readonly metadata?: WorkspaceEditEntryMetadata;
}

type WorkspaceEditEntry = IFileOperation | IFileTextEdit | IFileSnippetTextEdit;

export class SnippetTextEdit {
	static isSnippetTextEdit(thing: any): thing is SnippetTextEdit {
		if (thing instanceof SnippetTextEdit) {
			return true;
		}
		if (!thing) {
			return false;
		}
		return (
			Range.isRange((<SnippetTextEdit>thing).range) &&
			SnippetString.isSnippetString((<SnippetTextEdit>thing).snippet)
		);
	}

	static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
		return new SnippetTextEdit(range, snippet);
	}

	static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
		return SnippetTextEdit.replace(new Range(position, position), snippet);
	}

	range: Range;

	snippet: SnippetString;

	constructor(range: Range, snippet: SnippetString) {
		this.range = range;
		this.snippet = snippet;
	}
}

export class WorkspaceEdit {
	private readonly _edits: WorkspaceEditEntry[] = [];

	_allEntries(): ReadonlyArray<WorkspaceEditEntry> {
		return this._edits;
	}

	// --- file

	renameFile(
		from: Uri,
		to: Uri,
		options?: { readonly overwrite?: boolean; readonly ignoreIfExists?: boolean },
		metadata?: WorkspaceEditEntryMetadata
	): void {
		this._edits.push({ _type: FileEditType.File, from, to, options, metadata });
	}

	createFile(
		uri: Uri,
		options?: { readonly overwrite?: boolean; readonly ignoreIfExists?: boolean; readonly contents?: Uint8Array },
		metadata?: WorkspaceEditEntryMetadata
	): void {
		this._edits.push({ _type: FileEditType.File, from: undefined, to: uri, options, metadata });
	}

	deleteFile(
		uri: Uri,
		options?: { readonly recursive?: boolean; readonly ignoreIfNotExists?: boolean },
		metadata?: WorkspaceEditEntryMetadata
	): void {
		this._edits.push({ _type: FileEditType.File, from: uri, to: undefined, options, metadata });
	}

	// --- text

	replace(uri: Uri, range: Range, newText: string, metadata?: WorkspaceEditEntryMetadata): void {
		this._edits.push({ _type: FileEditType.Text, uri, edit: new TextEdit(range, newText), metadata });
	}

	insert(resource: Uri, position: Position, newText: string, metadata?: WorkspaceEditEntryMetadata): void {
		this.replace(resource, new Range(position, position), newText, metadata);
	}

	delete(resource: Uri, range: Range, metadata?: WorkspaceEditEntryMetadata): void {
		this.replace(resource, range, '', metadata);
	}

	// --- text (Maplike)

	has(uri: Uri): boolean {
		return this._edits.some(edit => edit._type === FileEditType.Text && edit.uri.toString() === uri.toString());
	}

	set(uri: Uri, edits: ReadonlyArray<TextEdit | SnippetTextEdit>): void;
	set(uri: Uri, edits: ReadonlyArray<[TextEdit | SnippetTextEdit, WorkspaceEditEntryMetadata]>): void;

	set(
		uri: Uri,
		edits:
			| null
			| undefined
			| ReadonlyArray<TextEdit | SnippetTextEdit | [TextEdit | SnippetTextEdit, WorkspaceEditEntryMetadata]>
	): void {
		if (!edits) {
			// remove all text, snippet, or notebook edits for `uri`
			for (let i = 0; i < this._edits.length; i++) {
				const element = this._edits[i];
				switch (element._type) {
					case FileEditType.Text:
					case FileEditType.Snippet:
						if (element.uri.toString() === uri.toString()) {
							this._edits[i] = undefined!; // will be coalesced down below
						}
						break;
				}
			}
			coalesceInPlace(this._edits);
		} else {
			// append edit to the end
			for (const editOrTuple of edits) {
				if (!editOrTuple) {
					continue;
				}
				let edit: TextEdit | SnippetTextEdit;
				let metadata: WorkspaceEditEntryMetadata | undefined;
				if (Array.isArray(editOrTuple)) {
					edit = editOrTuple[0];
					metadata = editOrTuple[1];
				} else {
					edit = editOrTuple;
				}
				if (SnippetTextEdit.isSnippetTextEdit(edit)) {
					this._edits.push({
						_type: FileEditType.Snippet,
						uri,
						range: edit.range,
						edit: edit.snippet,
						metadata,
					});
				} else {
					this._edits.push({ _type: FileEditType.Text, uri, edit, metadata });
				}
			}
		}
	}

	get(uri: Uri): TextEdit[] {
		const res: TextEdit[] = [];
		for (const candidate of this._edits) {
			if (candidate._type === FileEditType.Text && candidate.uri.toString() === uri.toString()) {
				res.push(candidate.edit);
			}
		}
		return res;
	}

	entries(): [Uri, TextEdit[]][] {
		const textEdits = new ResourceMap<[Uri, TextEdit[]]>();
		for (const candidate of this._edits) {
			if (candidate._type === FileEditType.Text) {
				let textEdit = textEdits.get(candidate.uri);
				if (!textEdit) {
					textEdit = [candidate.uri, []];
					textEdits.set(candidate.uri, textEdit);
				}
				textEdit[1].push(candidate.edit);
			}
		}
		return [...textEdits.values()];
	}

	get size(): number {
		return this.entries().length;
	}

	toJSON(): any {
		return this.entries();
	}
}


/**
 * Represents sources that can cause {@link window.onDidChangeTextEditorSelection selection change events}.
 */
export enum TextEditorSelectionChangeKind {
	/**
	 * Selection changed due to typing in the editor.
	 */
	Keyboard = 1,
	/**
	 * Selection change due to clicking in the editor.
	 */
	Mouse = 2,
	/**
	 * Selection changed because a command ran.
	 */
	Command = 3
}

/**
 * Reasons for why a text document has changed.
 */
export enum TextDocumentChangeReason {
	/** The text change is caused by an undo operation. */
	Undo = 1,

	/** The text change is caused by an redo operation. */
	Redo = 2,
}