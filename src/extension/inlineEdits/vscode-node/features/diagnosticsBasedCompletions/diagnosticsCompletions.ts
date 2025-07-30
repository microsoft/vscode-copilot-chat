/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DocumentId } from '../../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '../../../../../platform/inlineEdits/common/dataTypes/languageId';
import { RootedLineEdit } from '../../../../../platform/inlineEdits/common/dataTypes/rootedLineEdit';
import { IObservableDocument } from '../../../../../platform/inlineEdits/common/observableWorkspace';
import { min } from '../../../../../util/common/arrays';
import * as errors from '../../../../../util/common/errors';
import { ITracer } from '../../../../../util/common/tracing';
import { asPromise, raceCancellation, raceTimeout } from '../../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { LineEdit } from '../../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringReplacement } from '../../../../../util/vs/editor/common/core/edits/stringEdit';
import { TextEdit, TextReplacement } from '../../../../../util/vs/editor/common/core/edits/textEdit';
import { Position } from '../../../../../util/vs/editor/common/core/position';
import { Range } from '../../../../../util/vs/editor/common/core/range';
import { OffsetRange } from '../../../../../util/vs/editor/common/core/ranges/offsetRange';
import { INextEditDisplayLocation } from '../../../node/nextEditResult';
import { IVSCodeObservableDocument, IVSCodeObservableNotebookDocument, IVSCodeObservableTextDocument } from '../../parts/vscodeWorkspace';

export interface IDiagnosticCodeAction {
	edit: TextReplacement;
}

export abstract class DiagnosticCompletionItem implements vscode.InlineCompletionItem {

	static equals(a: DiagnosticCompletionItem, b: DiagnosticCompletionItem): boolean {
		return a.documentId.toString() === b.documentId.toString() &&
			Range.equalsRange(toInternalRange(a.range), toInternalRange(b.range)) &&
			a.insertText === b.insertText &&
			a.type === b.type &&
			a.isInlineEdit === b.isInlineEdit &&
			a.showInlineEditMenu === b.showInlineEditMenu &&
			displayLocationEquals(a.nextEditDisplayLocation, b.nextEditDisplayLocation);
	}

	public readonly isInlineEdit = true;
	public readonly showInlineEditMenu = true;

	public readonly abstract providerName: string;

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
	get nextEditDisplayLocation(): INextEditDisplayLocation | undefined {
		return this._getDisplayLocation();
	}
	get displayLocation(): vscode.InlineCompletionDisplayLocation | undefined {
		const displayLocation = this.nextEditDisplayLocation;
		return displayLocation ? { range: toExternalRange(displayLocation.range), label: displayLocation.label } : undefined;
	}
	get documentId(): DocumentId {
		return this._workspaceDocument.id;
	}

	constructor(
		public readonly type: string,
		public readonly diagnostic: Diagnostic,
		private readonly _edit: TextReplacement,
		protected readonly _workspaceDocument: IVSCodeObservableDocument,
	) { }

	toOffsetEdit() {
		return StringReplacement.replace(this._toOffsetRange(this._edit.range), this._edit.text);
	}

	toTextEdit() {
		return new TextEdit([this._edit]);
	}

	toLineEdit() {
		return LineEdit.fromTextEdit(this.toTextEdit(), this._workspaceDocument.value.get());
	}

	getDiagnosticOffsetRange() {
		return this._toOffsetRange(this.diagnostic.range);
	}

	getRootedLineEdit() {
		return new RootedLineEdit(this._workspaceDocument.value.get(), this.toLineEdit());
	}

	private _toOffsetRange(range: Range): OffsetRange {
		const transformer = this._workspaceDocument.value.get().getTransformer();
		return transformer.getOffsetRange(range);
	}

	// TODO: rethink if this needs to be updatable
	protected _getDisplayLocation(): INextEditDisplayLocation | undefined {
		return undefined;
	}
}

function displayLocationEquals(a: INextEditDisplayLocation | undefined, b: INextEditDisplayLocation | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.label === b.label && Range.equalsRange(a.range, b.range));
}

export interface IDiagnosticCompletionProvider<T extends DiagnosticCompletionItem = DiagnosticCompletionItem> {
	readonly providerName: string;
	providesCompletionsForDiagnostic(diagnostic: Diagnostic, language: LanguageId, pos: Position): boolean;
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

export async function getCodeActionsForDiagnostic(diagnostic: Diagnostic, workspaceDocument: IVSCodeObservableDocument, token: CancellationToken): Promise<CodeAction[] | undefined> {
	const executeCodeActionProviderPromise = workspaceDocument.kind === 'textDocument' ? getCodeActionsForTextDocumentDiagnostic(diagnostic, workspaceDocument) : getCodeActionsForNotebookDocumentDiagnostic(diagnostic, workspaceDocument);

	const codeActions = await raceTimeout(
		raceCancellation(
			executeCodeActionProviderPromise,
			token
		),
		1000
	);

	if (codeActions === undefined) {
		return undefined;
	}

	return codeActions.map(action => CodeAction.fromVSCodeCodeAction(action));
}
async function getCodeActionsForUriRange(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
	return asPromise(
		() => vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider',
			uri,
			range,
			vscode.CodeActionKind.QuickFix.value,
			3
		)
	);
}

async function getCodeActionsForTextDocumentDiagnostic(diagnostic: Diagnostic, workspaceDocument: IVSCodeObservableTextDocument): Promise<vscode.CodeAction[]> {
	return getCodeActionsForUriRange(workspaceDocument.id.toUri(), toExternalRange(diagnostic.range));
}

async function getCodeActionsForNotebookDocumentDiagnostic(diagnostic: Diagnostic, workspaceDocument: IVSCodeObservableNotebookDocument): Promise<vscode.CodeAction[]> {
	const cellRanges = workspaceDocument.fromRange(toExternalRange(diagnostic.range));
	if (!cellRanges || cellRanges.length === 0) {
		return [];
	}
	return Promise.all(cellRanges.map(async ([cell, range]) => {
		const actions = await getCodeActionsForUriRange(cell.uri, range);
		return actions.map(action => {
			action.diagnostics = action.diagnostics ? workspaceDocument.projectDiagnostics(cell, action.diagnostics) : undefined;
			return action;
		});
	})).then(results => results.flat());
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3
}

export namespace DiagnosticSeverity {
	export function fromVSCode(severity: vscode.DiagnosticSeverity): DiagnosticSeverity {
		switch (severity) {
			case vscode.DiagnosticSeverity.Error: return DiagnosticSeverity.Error;
			case vscode.DiagnosticSeverity.Warning: return DiagnosticSeverity.Warning;
			case vscode.DiagnosticSeverity.Information: return DiagnosticSeverity.Information;
			case vscode.DiagnosticSeverity.Hint: return DiagnosticSeverity.Hint;
		}
	}
}

export class Diagnostic {

	static fromVSCodeDiagnostic(diagnostic: vscode.Diagnostic): Diagnostic {
		return new Diagnostic(
			diagnostic.message,
			DiagnosticSeverity.fromVSCode(diagnostic.severity),
			diagnostic.source,
			toInternalRange(diagnostic.range),
			diagnostic.code && !(typeof diagnostic.code === 'number') && !(typeof diagnostic.code === 'string') ? diagnostic.code.value : diagnostic.code,
			diagnostic,
		);
	}

	static equals(a: Diagnostic, b: Diagnostic): boolean {
		return a.equals(b);
	}

	get range(): Range {
		return this._range;
	}

	private _isValid: boolean = true;
	isValid(): boolean {
		return this._isValid;
	}

	private constructor(
		public readonly message: string,
		public readonly severity: DiagnosticSeverity,
		public readonly source: string | undefined,
		private _range: Range,
		public readonly code: string | number | undefined,
		public readonly reference: vscode.Diagnostic
	) { }

	equals(other: Diagnostic): boolean {
		return this.code === other.code
			&& this.isValid() === other.isValid()
			&& this.severity === other.severity
			&& this.source === other.source
			&& this.message === other.message
			&& Range.equalsRange(this._range, other._range);
	}

	toString(): string {
		return `\`${this.message}\` at \`${this._range.toString()}\``;
	}

	updateRange(range: Range): void {
		this._range = range;
	}

	invalidate(): void {
		this._isValid = false;
	}
}

export class CodeAction {

	static fromVSCodeCodeAction(action: vscode.CodeAction): CodeAction {
		return new CodeAction(
			action.title,
			action.diagnostics?.map(diagnostic => Diagnostic.fromVSCodeDiagnostic(diagnostic)) ?? [],
			action.edit,
			action.command,
			action.kind,
			action.isPreferred,
			action.disabled
		);
	}

	private constructor(
		public readonly title: string,
		public readonly diagnostics: Diagnostic[],
		private readonly edit?: vscode.WorkspaceEdit,
		public readonly command?: vscode.Command,
		protected readonly kind?: vscode.CodeActionKind,
		public readonly isPreferred?: boolean,
		public readonly disabled?: { readonly reason: string }
	) { }

	toString(): string {
		return this.title;
	}

	hasEdit(): boolean {
		return this.edit !== undefined;
	}

	getEditForWorkspaceDocument(workspaceDocument: IVSCodeObservableDocument): TextReplacement[] | undefined {
		if (!this.edit) {
			return undefined;
		}
		return this.edit.get(workspaceDocument.id.toUri()).map(toInternalTextEdit);
	}

	getDiagnosticsReferencedInCommand(): Diagnostic[] {
		if (!this.command) {
			return [];
		}

		const commandArgs = this.command.arguments;
		if (!commandArgs || commandArgs.length === 0) {
			return [];
		}

		const referencedDiagnostics: Diagnostic[] = [];
		for (const arg of commandArgs) {
			if (arg && typeof arg === 'object' && 'diagnostic' in arg) {
				const diagnostic = arg.diagnostic;
				if (diagnostic && typeof diagnostic === 'object' && 'range' in diagnostic && 'message' in diagnostic && 'severity' in diagnostic) {
					referencedDiagnostics.push(Diagnostic.fromVSCodeDiagnostic(diagnostic));
				}
			}
		}

		return referencedDiagnostics;
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

export function toInternalRange(range: vscode.Range): Range {
	return new Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

export function toExternalRange(range: Range): vscode.Range {
	return new vscode.Range(toExternalPosition(range.getStartPosition()), toExternalPosition(range.getEndPosition()));
}

export function toInternalPosition(position: vscode.Position): Position {
	return new Position(position.line + 1, position.character + 1);
}

export function toExternalPosition(position: Position): vscode.Position {
	return new vscode.Position(position.lineNumber - 1, position.column - 1);
}

export function toInternalTextEdit(edit: vscode.TextEdit): TextReplacement {
	return new TextReplacement(toInternalRange(edit.range), edit.newText);
}

export function toExternalTextEdit(edit: TextReplacement): vscode.TextEdit {
	return new vscode.TextEdit(toExternalRange(edit.range), edit.text);
}

function diagnosticDistanceToPosition(diagnostic: Diagnostic, position: Position) {
	function positionDistance(a: Position, b: Position) {
		return { lineDelta: Math.abs(a.lineNumber - b.lineNumber), characterDelta: Math.abs(a.column - b.column) };
	}

	const a = positionDistance(diagnostic.range.getStartPosition(), position);
	const b = positionDistance(diagnostic.range.getEndPosition(), position);

	if (a.lineDelta === b.lineDelta) {
		return a.characterDelta < b.characterDelta ? a : b;
	}

	return a.lineDelta < b.lineDelta ? a : b;
}

export function isDiagnosticWithinDistance(diagnostic: Diagnostic, position: Position, maxLineDistance: number): boolean {
	return diagnosticDistanceToPosition(diagnostic, position).lineDelta <= maxLineDistance;
}

export function sortDiagnosticsByDistance(diagnostics: Diagnostic[], position: Position): Diagnostic[] {
	return diagnostics.sort((a, b) => {
		const aDistance = diagnosticDistanceToPosition(a, position);
		const bDistance = diagnosticDistanceToPosition(b, position);
		if (aDistance.lineDelta === bDistance.lineDelta) {
			return aDistance.characterDelta - bDistance.characterDelta;
		}
		return aDistance.lineDelta - bDistance.lineDelta;
	});
}

export function distanceToClosestDiagnostic(diagnostics: Diagnostic[], position: Position): number | undefined {
	if (diagnostics.length === 0) {
		return undefined;
	}

	const distances = diagnostics.map(diagnostic => diagnosticDistanceToPosition(diagnostic, position).lineDelta);

	return min(distances);
}
