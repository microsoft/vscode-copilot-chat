/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageId } from '../../../../../platform/inlineEdits/common/dataTypes/languageId';
import { ITracer } from '../../../../../util/common/tracing';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { TextReplacement } from '../../../../../util/vs/editor/common/core/edits/textEdit';
import { Position } from '../../../../../util/vs/editor/common/core/position';
import { IVSCodeObservableDocument } from '../../parts/vscodeWorkspace';
import { CodeAction, Diagnostic, DiagnosticCompletionItem, DiagnosticInlineEditRequestLogContext, getCodeActionsForDiagnostic, IDiagnosticCodeAction, IDiagnosticCompletionProvider, isDiagnosticWithinDistance, log } from './diagnosticsCompletions';

class AsyncDiagnosticCompletionItem extends DiagnosticCompletionItem {
	public static readonly type = 'async';

	public readonly providerName = 'async';

	constructor(
		diagnostic: Diagnostic,
		edit: TextReplacement,
		workspaceDocument: IVSCodeObservableDocument,
	) {
		super(AsyncDiagnosticCompletionItem.type, diagnostic, edit, workspaceDocument);
	}
}
export class AsyncDiagnosticCompletionProvider implements IDiagnosticCompletionProvider<AsyncDiagnosticCompletionItem> {

	public static SupportedLanguages = new Set<string>(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

	public readonly providerName = 'async';

	constructor(private readonly _tracer: ITracer) { }

	public providesCompletionsForDiagnostic(diagnostic: Diagnostic, language: LanguageId, pos: Position): boolean {
		if (!AsyncDiagnosticCompletionProvider.SupportedLanguages.has(language)) {
			return false;
		}

		if (!isDiagnosticWithinDistance(diagnostic, pos, 3)) {
			return false;
		}

		return isAsyncDiagnostics(diagnostic);
	}

	async provideDiagnosticCompletionItem(workspaceDocument: IVSCodeObservableDocument, sortedDiagnostics: Diagnostic[], pos: Position, logContext: DiagnosticInlineEditRequestLogContext, token: CancellationToken): Promise<AsyncDiagnosticCompletionItem | null> {
		const missingAsyncDiagnostic = sortedDiagnostics.find(diagnostic => this.providesCompletionsForDiagnostic(diagnostic, workspaceDocument.languageId.get(), pos));
		if (missingAsyncDiagnostic === undefined) {
			return null;
		}

		// fetch code actions for missing async
		const availableCodeActions = await getCodeActionsForDiagnostic(missingAsyncDiagnostic, workspaceDocument, token);
		if (availableCodeActions === undefined) {
			log(`Fetching code actions likely timed out for \`${missingAsyncDiagnostic.message}\``, logContext, this._tracer);
			return null;
		}

		const asyncCodeActions = getAsyncCodeActions(availableCodeActions, workspaceDocument);
		if (asyncCodeActions.length === 0) {
			log('No async code actions found in the available code actions', logContext, this._tracer);
			return null;
		}

		const asyncCodeActionToShow = asyncCodeActions[0];
		const item = new AsyncDiagnosticCompletionItem(missingAsyncDiagnostic, asyncCodeActionToShow.edit, workspaceDocument);

		log(`Created async completion item for: \`${missingAsyncDiagnostic.toString()}\``, logContext, this._tracer);

		return item;
	}
}

function isAsyncDiagnostics(diagnostic: Diagnostic): boolean {
	return diagnostic.code === 1308;
}

const CODE_ACTION_ASYNC_TITLE_PREFIXES = ['Add async', 'Update async'];

function getAsyncCodeActions(codeActions: CodeAction[], workspaceDocument: IVSCodeObservableDocument): IDiagnosticCodeAction[] {

	const asyncCodeActions: IDiagnosticCodeAction[] = [];
	for (const codeAction of codeActions) {
		const asyncTitlePrefix = CODE_ACTION_ASYNC_TITLE_PREFIXES.find(prefix => codeAction.title.startsWith(prefix));

		const isAsyncCodeAction = !!asyncTitlePrefix;
		if (!isAsyncCodeAction) {
			continue;
		}

		const edits = codeAction.getEditForWorkspaceDocument(workspaceDocument);
		if (!edits) {
			continue;
		}

		const joinedEdit = TextReplacement.joinReplacements(edits, workspaceDocument.value.get());

		asyncCodeActions.push({
			...codeAction,
			edit: joinedEdit,
		});
	}

	return asyncCodeActions;
}