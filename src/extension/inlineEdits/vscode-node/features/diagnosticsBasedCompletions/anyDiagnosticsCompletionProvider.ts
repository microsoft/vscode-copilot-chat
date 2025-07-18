/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageId } from '../../../../../platform/inlineEdits/common/dataTypes/languageId';
import { ITracer } from '../../../../../util/common/tracing';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { TextReplacement } from '../../../../../util/vs/editor/common/core/edits/textEdit';
import { Position } from '../../../../../util/vs/editor/common/core/position';
import { INextEditDisplayLocation } from '../../../node/nextEditResult';
import { IVSCodeObservableDocument } from '../../parts/vscodeWorkspace';
import { CodeAction, Diagnostic, DiagnosticCompletionItem, DiagnosticInlineEditRequestLogContext, getCodeActionsForDiagnostic, IDiagnosticCodeAction, IDiagnosticCompletionProvider, isDiagnosticWithinDistance, log, logList } from './diagnosticsCompletions';

interface IAnyCodeAction extends IDiagnosticCodeAction {
	type: string;
}

export class AnyDiagnosticCompletionItem extends DiagnosticCompletionItem {

	public readonly providerName = 'any';

	constructor(
		codeAction: IAnyCodeAction,
		diagnostic: Diagnostic,
		private readonly _nextEditDisplayLocation: INextEditDisplayLocation | undefined,
		workspaceDocument: IVSCodeObservableDocument,
	) {
		super(codeAction.type, diagnostic, codeAction.edit, workspaceDocument);
	}

	protected override _getDisplayLocation(): INextEditDisplayLocation | undefined {
		return this._nextEditDisplayLocation;
	}
}

export class AnyDiagnosticCompletionProvider implements IDiagnosticCompletionProvider<AnyDiagnosticCompletionItem> {

	public static SupportedLanguages = new Set<string>(['*']);

	public readonly providerName = 'any';

	constructor(private readonly _tracer: ITracer) { }

	public providesCompletionsForDiagnostic(diagnostic: Diagnostic, language: LanguageId, pos: Position): boolean {
		return isDiagnosticWithinDistance(diagnostic, pos, 5);
	}

	async provideDiagnosticCompletionItem(workspaceDocument: IVSCodeObservableDocument, sortedDiagnostics: Diagnostic[], pos: Position, logContext: DiagnosticInlineEditRequestLogContext, token: CancellationToken): Promise<AnyDiagnosticCompletionItem | null> {

		for (const diagnostic of sortedDiagnostics) {
			const availableCodeActions = await getCodeActionsForDiagnostic(diagnostic, workspaceDocument, token);
			if (availableCodeActions === undefined) {
				log(`Fetching code actions likely timed out for \`${diagnostic.message}\``, logContext, this._tracer);
				continue;
			}

			const codeActionsFixingCodeAction = availableCodeActions.filter(action => doesCodeActionFixDiagnostics(action, diagnostic));
			if (codeActionsFixingCodeAction.length === 0) {
				continue;
			}

			logList(`Found the following code action which fix \`${diagnostic.message}\``, codeActionsFixingCodeAction, logContext, this._tracer);

			const filteredCodeActionsWithEdit = filterCodeActions(codeActionsFixingCodeAction, workspaceDocument);

			if (filteredCodeActionsWithEdit.length === 0) {
				continue;
			}

			const codeAction = filteredCodeActionsWithEdit[0];
			const edits = codeAction.getEditForWorkspaceDocument(workspaceDocument);
			if (!edits) { continue; }

			const joinedEdit = TextReplacement.joinReplacements(edits, workspaceDocument.value.get());
			const anyCodeAction: IAnyCodeAction = {
				edit: joinedEdit,
				type: getSanitizedCodeActionTitle(codeAction)
			};

			let displayLocation: INextEditDisplayLocation | undefined;
			const editDistance = Math.abs(joinedEdit.range.startLineNumber - pos.lineNumber);
			if (editDistance > 12) {
				displayLocation = { range: diagnostic.range, label: codeAction.title };
			}

			const item = new AnyDiagnosticCompletionItem(anyCodeAction, diagnostic, displayLocation, workspaceDocument);
			log(`Created Completion Item for diagnostic: ${diagnostic.message}: ${item.toLineEdit().toString()}`);
			return item;
		}

		return null;
	}

	completionItemRejected(item: AnyDiagnosticCompletionItem): void { }
}

function doesCodeActionFixDiagnostics(action: CodeAction, diagnostic: Diagnostic): boolean {
	const CodeActionFixedDiagnostics = [...action.diagnostics, ...action.getDiagnosticsReferencedInCommand()];
	return CodeActionFixedDiagnostics.some(d => diagnostic.equals(d));
}

function getSanitizedCodeActionTitle(action: CodeAction): string {
	return action.title.replace(/(["'])(.*?)\1/g, '$1...$1');
}

function filterCodeActions(codeActionsWithEdit: CodeAction[], workspaceDocument: IVSCodeObservableDocument): CodeAction[] {
	return codeActionsWithEdit.filter(action => {
		const edit = action.getEditForWorkspaceDocument(workspaceDocument);
		if (!edit) { return false; }

		if (action.title === 'Infer parameter types from usage') {
			if (edit.length === 0) { return false; }
			if (edit.length === 1 && ['any', 'unknown', 'undefined'].some(e => edit[0].text.includes(e))) { return false; }
		}

		return true;
	});
}
