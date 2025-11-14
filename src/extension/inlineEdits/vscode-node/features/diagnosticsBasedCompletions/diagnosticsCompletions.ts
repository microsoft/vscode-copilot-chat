/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiagnosticData } from '../../../../../platform/inlineEdits/common/dataTypes/diagnosticData';
import { DocumentId } from '../../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '../../../../../platform/inlineEdits/common/dataTypes/languageId';
import { RootedLineEdit } from '../../../../../platform/inlineEdits/common/dataTypes/rootedLineEdit';
import { IObservableDocument } from '../../../../../platform/inlineEdits/common/observableWorkspace';
import { min } from '../../../../../util/common/arrays';
import * as errors from '../../../../../util/common/errors';
import { ITracer } from '../../../../../util/common/tracing';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { LineEdit } from '../../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringReplacement } from '../../../../../util/vs/editor/common/core/edits/stringEdit';
import { TextEdit, TextReplacement } from '../../../../../util/vs/editor/common/core/edits/textEdit';
import { Position } from '../../../../../util/vs/editor/common/core/position';
import { Range } from '../../../../../util/vs/editor/common/core/range';
import { OffsetRange } from '../../../../../util/vs/editor/common/core/ranges/offsetRange';
import { Command } from '../../../../../vscodeTypes';
import { INextEditDisplayLocation } from '../../../node/nextEditResult';
import { IVSCodeObservableDocument } from '../../parts/vscodeWorkspace';
import { toExternalRange, toInternalRange } from '../../utils/translations';

export interface IDiagnosticCodeAction {
	edit: TextReplacement;
}

export abstract class DiagnosticCompletionItem implements vscode.InlineCompletionItem {

	static equals(a: DiagnosticCompletionItem, b: DiagnosticCompletionItem): boolean {
		return a.documentId.toString() === b.documentId.toString() &&
			(a.range !== undefined && b.range !== undefined && Range.equalsRange(toInternalRange(a.range), toInternalRange(b.range)) || a.range === undefined && b.range === undefined) &&
			a.insertText === b.insertText &&
			a.type === b.type &&
			a.isInlineEdit === b.isInlineEdit &&
			a.showInlineEditMenu === b.showInlineEditMenu &&
			displayLocationEquals(a.nextEditDisplayLocation, b.nextEditDisplayLocation);
	}

	public readonly isInlineEdit = true;
	public readonly showInlineEditMenu = true;

	public readonly abstract providerName: string;

	get nextEditDisplayLocation(): INextEditDisplayLocation | undefined {
		return this._getDisplayLocation();
	}
	get displayLocation(): vscode.InlineCompletionDisplayLocation | undefined {
		const displayLocation = this.nextEditDisplayLocation;
		return displayLocation ? {
			range: toExternalRange(displayLocation.range),
			label: displayLocation.label,
			kind: vscode.InlineCompletionDisplayLocationKind.Code
		} : undefined;
	}
	get documentId(): DocumentId {
		return this._workspaceDocument.id;
	}

	get command(): Command | undefined {
		return this.result.command;
	}

	get insertText(): string {
		return this.result.insertText!;
	}

	get range(): vscode.Range | undefined {
		return this.result.range;
	}

	public readonly result: DiagnosticEditResult | DiagnosticCommandResult;

	constructor(
		public readonly type: string,
		public readonly diagnostic: Diagnostic,
		private readonly _editOrCommand: TextReplacement | Command,
		protected readonly _workspaceDocument: IVSCodeObservableDocument,
	) {
		this.result = this._editOrCommand instanceof TextReplacement ? new DiagnosticEditResult(this._editOrCommand, this._workspaceDocument) : new DiagnosticCommandResult(this._editOrCommand);
	}

	getDiagnosticOffsetRange(): OffsetRange {
		return this.diagnostic.range;
	}

	// TODO: rethink if this needs to be updatable
	protected _getDisplayLocation(): INextEditDisplayLocation | undefined {
		return undefined;
	}
}

export class DiagnosticEditResult {

	public readonly command: undefined;
	public readonly type = 'edit';

	private _range: vscode.Range | undefined;
	get range(): vscode.Range {
		if (!this._range) {
			this._range = toExternalRange(this._edit.range);
		}
		return this._range;
	}
	get insertText(): string {
		return this._edit.text;
	}

	constructor(
		private readonly _edit: TextReplacement,
		private readonly _workspaceDocument: IVSCodeObservableDocument,
	) { }

	getRootedLineEdit(): RootedLineEdit {
		return new RootedLineEdit(this._workspaceDocument.value.get(), this._toLineEdit(this._edit));
	}

	toOffsetEdit(): StringReplacement {
		return StringReplacement.replace(this._toOffsetRange(this._edit.range), this._edit.text);
	}

	toRejectionCollectorEdit(): StringReplacement {
		return this.toOffsetEdit();
	}

	private _toOffsetRange(range: Range): OffsetRange {
		const transformer = this._workspaceDocument.value.get().getTransformer();
		return transformer.getOffsetRange(range);
	}

	private _toLineEdit(edit: TextReplacement): LineEdit {
		return LineEdit.fromTextEdit(new TextEdit([edit]), this._workspaceDocument.value.get());
	}

	toString(): string {
		return this._toLineEdit(this._edit).toString();
	}
}

export class DiagnosticCommandResult {

	public readonly range: undefined;
	public readonly insertText: undefined;
	public readonly type = 'command';

	constructor(
		public readonly command: Command
	) { }

	toString(): string {
		return `${this.command.title}(${this.command.command})${this.command.arguments ? `: [${this.command.arguments?.join(', ')}]` : ''}`;
	}

	toRejectionCollectorEdit(): StringReplacement {
		return new StringReplacement(new OffsetRange(0, 0), this.toString());
	}
}

function displayLocationEquals(a: INextEditDisplayLocation | undefined, b: INextEditDisplayLocation | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.label === b.label && Range.equalsRange(a.range, b.range));
}

export interface IDiagnosticCompletionProvider<T extends DiagnosticCompletionItem = DiagnosticCompletionItem> {
	readonly providerName: string;
	providesCompletionsForDiagnostic(workspaceDocument: IVSCodeObservableDocument, diagnostic: Diagnostic, language: LanguageId, pos: Position): boolean;
	provideDiagnosticCompletionItem(workspaceDocument: IVSCodeObservableDocument, sortedDiagnostics: Diagnostic[], pos: Position, logContext: DiagnosticInlineEditRequestLogContext, token: CancellationToken): Promise<T | null>;
	completionItemRejected?(item: T): void;
	isCompletionItemStillValid?(item: T, workspaceDocument: IObservableDocument): boolean;
}

// TODO: Better incorporate diagnostics logging
export class DiagnosticInlineEditRequestLogContext {

	getLogs(): string[] {
		if (!this._markedToBeLogged) {
			return [];
		}

		const lines = [];

		if (this._error) {
			lines.push(`## Diagnostics Error`);
			lines.push("```");
			lines.push(errors.toString(errors.fromUnknown(this._error)));
			lines.push("```");
		}

		if (this._logs.length > 0) {
			lines.push(`## Diagnostics Logs`);
			lines.push(...this._logs);
		}

		return lines;
	}

	private _logs: string[] = [];
	addLog(content: string): void {
		this._logs.push(content.replace('\n', '\\n').replace('\t', '\\t').replace('`', '\`') + '\n');
	}

	private _markedToBeLogged: boolean = false;
	markToBeLogged() {
		this._markedToBeLogged = true;
	}

	private _error: unknown | undefined = undefined;
	setError(e: unknown): void {
		this._markedToBeLogged = true;
		this._error = e;
	}

}

export class Diagnostic {

	static equals(a: Diagnostic, b: Diagnostic): boolean {
		return a.equals(b);
	}

	private _updatedRange: OffsetRange;
	get range(): OffsetRange {
		return this._updatedRange;
	}

	private _isValid: boolean = true;
	isValid(): boolean {
		return this._isValid;
	}

	get message(): string {
		return this.data.message;
	}

	constructor(
		public readonly data: DiagnosticData
	) {
		this._updatedRange = data.range;
	}

	equals(other: Diagnostic): boolean {
		return this.data.equals(other.data)
			&& this._updatedRange.equals(other.range)
			&& this._isValid === other._isValid;
	}

	toString(): string {
		if (this.data.range !== this._updatedRange) {
			return `\`${this.data.toString()}\` (currently at \`${this._updatedRange.toString()}\`)`;
		}
		return `\`${this.data.toString()}\``;
	}

	updateRange(range: OffsetRange): void {
		this._updatedRange = range;
	}

	invalidate(): void {
		this._isValid = false;
	}
}

export function log(message: string, logContext?: DiagnosticInlineEditRequestLogContext, tracer?: ITracer) {
	if (logContext) {
		const lines = message.split('\n');
		lines.forEach(line => logContext.addLog(line));
	}

	if (tracer) {
		tracer.trace(message);
	}
}

export function logList(title: string, list: Array<string | { toString(): string }>, logContext?: DiagnosticInlineEditRequestLogContext, tracer?: ITracer) {
	const content = `${title}${list.map(item => `\n- ${typeof item === 'string' ? item : item.toString()}`).join('')}`;
	log(content, logContext, tracer);
}

// TODO: there must be a utility for this somewhere? Otherwise make them available

function diagnosticDistanceToPosition(workspaceDocument: IObservableDocument, diagnostic: Diagnostic, position: Position) {
	function positionDistance(a: Position, b: Position) {
		return { lineDelta: Math.abs(a.lineNumber - b.lineNumber), characterDelta: Math.abs(a.column - b.column) };
	}

	const range = workspaceDocument.value.get().getTransformer().getRange(diagnostic.range);
	const a = positionDistance(range.getStartPosition(), position);
	const b = positionDistance(range.getEndPosition(), position);

	if (a.lineDelta === b.lineDelta) {
		return a.characterDelta < b.characterDelta ? a : b;
	}

	return a.lineDelta < b.lineDelta ? a : b;
}

export function isDiagnosticWithinDistance(workspaceDocument: IObservableDocument, diagnostic: Diagnostic, position: Position, maxLineDistance: number): boolean {
	return diagnosticDistanceToPosition(workspaceDocument, diagnostic, position).lineDelta <= maxLineDistance;
}

export function sortDiagnosticsByDistance(workspaceDocument: IObservableDocument, diagnostics: Diagnostic[], position: Position): Diagnostic[] {
	const transformer = workspaceDocument.value.get().getTransformer();
	return diagnostics.sort((a, b) => {
		const aDistance = diagnosticDistanceToPosition(workspaceDocument, a, position);
		const bDistance = diagnosticDistanceToPosition(workspaceDocument, b, position);

		if (aDistance.lineDelta !== bDistance.lineDelta) {
			return aDistance.lineDelta - bDistance.lineDelta;
		}

		const aPosition = transformer.getPosition(a.range.start);
		const bPosition = transformer.getPosition(b.range.start);

		if (aPosition.lineNumber !== bPosition.lineNumber) {
			return aDistance.characterDelta - bDistance.characterDelta;
		}

		if (aDistance.lineDelta < 2) {
			return aDistance.characterDelta - bDistance.characterDelta;
		}

		// If both diagnostics are on the same line and are more than 1 line away from the cursor
		// always prefer the first diagnostic to minimize recomputation and flickering on cursor move
		return -1;
	});
}

export function distanceToClosestDiagnostic(workspaceDocument: IObservableDocument, diagnostics: Diagnostic[], position: Position): number | undefined {
	if (diagnostics.length === 0) {
		return undefined;
	}

	const distances = diagnostics.map(diagnostic => diagnosticDistanceToPosition(workspaceDocument, diagnostic, position).lineDelta);

	return min(distances);
}
