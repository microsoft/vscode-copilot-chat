/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { applyEditsToRanges } from '../../../../platform/editSurvivalTracking/common/editSurvivalTracker';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { Edits } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { ObservableGit } from '../../../../platform/inlineEdits/common/observableGit';
import { IObservableDocument } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { autorunWithChanges } from '../../../../platform/inlineEdits/common/utils/observable';
import { WorkspaceDocumentEditHistory } from '../../../../platform/inlineEdits/common/workspaceEditTracker/workspaceDocumentEditTracker';
import { ILanguageDiagnosticsService } from '../../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITabsAndEditorsService } from '../../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createTracer, ITracer } from '../../../../util/common/tracing';
import { equals } from '../../../../util/vs/base/common/arrays';
import { findFirstMonotonous } from '../../../../util/vs/base/common/arraysFind';
import { ThrottledDelayer } from '../../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { BugIndicatingError } from '../../../../util/vs/base/common/errors';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { autorun, derived, IObservable } from '../../../../util/vs/base/common/observableInternal';
import { isEqual } from '../../../../util/vs/base/common/resources';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { Position } from '../../../../util/vs/editor/common/core/position';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { getInformationDelta, InformationDelta } from '../../common/ghNearbyNesProvider';
import { RejectionCollector } from '../../common/rejectionCollector';
import { IVSCodeObservableDocument, VSCodeWorkspace } from '../parts/vscodeWorkspace';
import { AnyDiagnosticCompletionItem, AnyDiagnosticCompletionProvider } from './diagnosticsBasedCompletions/anyDiagnosticsCompletionProvider';
import { AsyncDiagnosticCompletionProvider } from './diagnosticsBasedCompletions/asyncDiagnosticsCompletionProvider';
import { Diagnostic, DiagnosticCompletionItem, DiagnosticInlineEditRequestLogContext, DiagnosticSeverity, distanceToClosestDiagnostic, IDiagnosticCompletionProvider, log, logList, sortDiagnosticsByDistance, toInternalPosition } from './diagnosticsBasedCompletions/diagnosticsCompletions';
import { ImportDiagnosticCompletionItem, ImportDiagnosticCompletionProvider } from './diagnosticsBasedCompletions/importDiagnosticsCompletionProvider';

interface IDiagnosticsCompletionState<T extends DiagnosticCompletionItem = DiagnosticCompletionItem> {
	completionItem: T | null;
	logContext: DiagnosticInlineEditRequestLogContext;
	telemetryBuilder: DiagnosticsCompletionHandlerTelemetry;
}

function diagnosticCompletionRunResultEquals(a: IDiagnosticsCompletionState, b: IDiagnosticsCompletionState): boolean {
	if (!!a.completionItem && !!b.completionItem) {
		return DiagnosticCompletionItem.equals(a.completionItem, b.completionItem);
	}
	return a.completionItem === b.completionItem;
}

// Only exported for testing
export class DiagnosticsCollection {

	private _diagnostics: Diagnostic[] = [];

	applyEdit(previous: StringText, edit: StringEdit, after: StringText): boolean {
		const transformerBefore = previous.getTransformer();
		const transformerAfter = after.getTransformer();

		let hasInvalidated = false;
		for (const diagnostic of this._diagnostics) {
			const oldRange = diagnostic.range;
			const oldOffsetRange = transformerBefore.getOffsetRange(oldRange);
			const newOffsetRange = applyEditsToRanges([oldOffsetRange], edit)[0];

			// If the range shrank then the diagnostic will have changed
			if (!newOffsetRange || newOffsetRange.length < oldOffsetRange.length) {
				diagnostic.invalidate();
				hasInvalidated = true;
				continue;
			}

			const contentAtOldRange = previous.getValueOfRange(oldRange);

			// If the range stays the same then the diagnostic is still valid
			if (newOffsetRange.length === oldOffsetRange.length) {
				const newRange = transformerAfter.getRange(newOffsetRange);
				const contentAtNewRange = after.getValueOfRange(newRange);
				if (contentAtOldRange === contentAtNewRange) {
					diagnostic.updateRange(newRange);
				} else {
					diagnostic.invalidate();
					hasInvalidated = true;
				}
				continue;
			}

			// If the range grew then we need to check what got added
			const sameLengthPrefixRange = Range.fromPositions(
				transformerAfter.getPosition(newOffsetRange.start),
				transformerAfter.getPosition(newOffsetRange.start + oldOffsetRange.length)
			);
			const sameLengthSuffixRange = Range.fromPositions(
				transformerAfter.getPosition(newOffsetRange.endExclusive - oldOffsetRange.length),
				transformerAfter.getPosition(newOffsetRange.endExclusive)
			);

			const isSamePrefix = contentAtOldRange === after.getValueOfRange(sameLengthPrefixRange);
			const isSameSuffix = contentAtOldRange === after.getValueOfRange(sameLengthSuffixRange);
			if (!isSamePrefix && !isSameSuffix) {
				// The content at the diagnostic range has changed
				diagnostic.invalidate();
				hasInvalidated = true;
				continue;
			}

			let edgeCharacter;
			if (isSamePrefix) {
				const offsetAfterOldRange = newOffsetRange.endExclusive - (newOffsetRange.length - oldOffsetRange.length);
				edgeCharacter = after.getValueOfRange(Range.fromPositions(
					transformerAfter.getPosition(offsetAfterOldRange),
					transformerAfter.getPosition(offsetAfterOldRange + 1)
				));
			} else {
				const offsetBeforeOldRange = newOffsetRange.start + (oldOffsetRange.length - newOffsetRange.length) + 1;
				edgeCharacter = after.getValueOfRange(Range.fromPositions(
					transformerAfter.getPosition(offsetBeforeOldRange),
					transformerAfter.getPosition(offsetBeforeOldRange + 1)
				));
			}

			if (edgeCharacter.length !== 1 || /^[a-zA-Z0-9_]$/.test(edgeCharacter)) {
				// The content at the diagnostic range has changed
				diagnostic.invalidate();
				hasInvalidated = true;
				continue;
			}

			// We need to update the range of the diagnostic after applying the edits
			let newRange: Range;
			if (isSamePrefix) {
				newRange = Range.fromPositions(
					transformerAfter.getPosition(newOffsetRange.start),
					transformerAfter.getPosition(newOffsetRange.start + oldOffsetRange.length)
				);
			} else {
				newRange = Range.fromPositions(
					transformerAfter.getPosition(newOffsetRange.endExclusive - oldOffsetRange.length),
					transformerAfter.getPosition(newOffsetRange.endExclusive)
				);
			}

			diagnostic.updateRange(newRange);
		}

		return hasInvalidated;
	}

	isEqualAndUpdate(relevantDiagnostics: Diagnostic[]): boolean {
		if (equals(this._diagnostics, relevantDiagnostics, Diagnostic.equals)) {
			return true;
		}
		this._diagnostics = relevantDiagnostics;
		return false;
	}

	toString(): string {
		return this._diagnostics.map(d => d.toString()).join('\n');
	}
}

export type DiagnosticCompletionState = {
	item: DiagnosticCompletionItem | undefined;
	telemetry: IDiagnosticsCompletionTelemetry;
	logContext: DiagnosticInlineEditRequestLogContext | undefined;
};

export class DiagnosticsCompletionProcessor extends Disposable {

	static get documentSelector(): vscode.DocumentSelector {
		return Array.from(new Set([
			...ImportDiagnosticCompletionProvider.SupportedLanguages,
			...AsyncDiagnosticCompletionProvider.SupportedLanguages
		]));
	}

	private readonly _onDidChange = this._register(new Emitter<boolean>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _worker = new AsyncWorker<IDiagnosticsCompletionState>(20, diagnosticCompletionRunResultEquals);

	private readonly _rejectionCollector: RejectionCollector;
	private readonly _diagnosticsCompletionProviders: IObservable<IDiagnosticCompletionProvider[]>;
	private readonly _workspaceDocumentEditHistory: WorkspaceDocumentEditHistory;
	private readonly _currentDiagnostics = new DiagnosticsCollection();

	private readonly _tracer: ITracer;

	constructor(
		private readonly _workspace: VSCodeWorkspace,
		git: ObservableGit,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IFileSystemService fileSystemService: IFileSystemService,
		@ITabsAndEditorsService private readonly _tabsAndEditorsService: ITabsAndEditorsService,
		@ILanguageDiagnosticsService private readonly _languageDiagnosticsService: ILanguageDiagnosticsService
	) {
		super();

		this._workspaceDocumentEditHistory = this._register(new WorkspaceDocumentEditHistory(this._workspace, git, 100));

		this._tracer = createTracer(['NES', 'DiagnosticsInlineCompletionProvider'], (s) => logService.trace(s));

		const diagnosticsExplorationEnabled = configurationService.getConfigObservable(ConfigKey.Internal.InlineEditsDiagnosticsExplorationEnabled);

		const importProvider = new ImportDiagnosticCompletionProvider(this._tracer.sub('Import'), workspaceService, fileSystemService);
		const asyncProvider = new AsyncDiagnosticCompletionProvider(this._tracer.sub('Async'));

		this._diagnosticsCompletionProviders = derived(reader => {
			const providers: IDiagnosticCompletionProvider[] = [
				importProvider,
				asyncProvider
			];

			if (diagnosticsExplorationEnabled.read(reader)) {
				providers.push(new AnyDiagnosticCompletionProvider(this._tracer.sub('All')));
			}

			return providers;
		}).recomputeInitiallyAndOnChange(this._store);

		this._rejectionCollector = new RejectionCollector(this._workspace, s => this._tracer.trace(s));

		this._register(this._languageDiagnosticsService.onDidChangeDiagnostics(async e => {
			const activeEditor = this._tabsAndEditorsService.activeTextEditor;
			if (!activeEditor || !isEditorFromEditorGrid(activeEditor)) {
				return;
			}

			const diagnosticsChangedForActiveEditor = e.uris.some(uri => isEqual(uri, activeEditor.document.uri));
			if (!diagnosticsChangedForActiveEditor) {
				return;
			}

			this._updateState();
		}));

		this._register(this._tabsAndEditorsService.onDidChangeActiveTextEditor(async e => {
			const activeEditor = e;
			if (!activeEditor || !isEditorFromEditorGrid(activeEditor)) {
				return;
			}

			this._updateState();
		}));

		this._register(vscode.window.onDidChangeTextEditorSelection(async e => {
			const activeEditor = this._tabsAndEditorsService.activeTextEditor;
			if (!activeEditor || !isEditorFromEditorGrid(activeEditor)) {
				return;
			}

			if (!isEqual(e.textEditor.document.uri, activeEditor.document.uri)) {
				return;
			}

			this._updateState();
		}));

		this._register(this._worker.onDidChange(result => {
			this._onDidChange.fire(!!result.completionItem);
		}));

		this._register(autorun(reader => {
			const document = this._workspace.lastActiveDocument.read(reader);
			if (!document) { return; }

			reader.store.add(autorunWithChanges(this, {
				value: document.value,
			}, (data) => {
				for (const edit of data.value.changes) {
					if (!data.value.previous) { continue; }
					const hasInvalidatedRange = this._currentDiagnostics.applyEdit(data.value.previous, edit, data.value.value);
					if (hasInvalidatedRange) {
						this._updateState();
					}
				}
			}));
		}));
	}

	private async _updateState(): Promise<void> {
		const activeTextEditor = this._tabsAndEditorsService.activeTextEditor;
		if (!activeTextEditor) { return; }

		const workspaceDocument = this._workspace.getDocumentByTextDocument(activeTextEditor.document);
		if (!workspaceDocument) { return; }

		const log = new DiagnosticInlineEditRequestLogContext();

		const cursor = toInternalPosition(activeTextEditor.selection.active);

		const { availableDiagnostics, relevantDiagnostics } = this._getDiagnostics(workspaceDocument, cursor, log);
		const diagnosticsSorted = sortDiagnosticsByDistance(relevantDiagnostics, cursor);

		if (this._currentDiagnostics.isEqualAndUpdate(diagnosticsSorted)) {
			return;
		}

		this._tracer.trace('Scheduled update for diagnostics inline completion');

		await this._worker.schedule(async (token: CancellationToken) => this._runCompletionHandler(workspaceDocument, diagnosticsSorted, availableDiagnostics, cursor, log, token));
	}

	private _getDiagnostics(workspaceDocument: IVSCodeObservableDocument, cursor: Position, logContext: DiagnosticInlineEditRequestLogContext): { availableDiagnostics: Diagnostic[]; relevantDiagnostics: Diagnostic[] } {
		const diagnostics = workspaceDocument.kind === 'textDocument' ?
			this._languageDiagnosticsService
				.getDiagnostics(workspaceDocument.textDocument.uri) :
			workspaceDocument.notebook.getCells().flatMap(cell => this._languageDiagnosticsService
				.getDiagnostics(cell.document.uri)
				.flatMap(diagnostic => workspaceDocument.projectDiagnostics(cell.document, [diagnostic])));
		const availableDiagnostics = diagnostics
			.map(diagnostic => Diagnostic.fromVSCodeDiagnostic(diagnostic))
			.filter(diagnostic => diagnostic.severity !== DiagnosticSeverity.Information)
			.filter(diagnostic => diagnostic.severity !== DiagnosticSeverity.Hint);

		if (availableDiagnostics.length === 0) {
			return { availableDiagnostics: [], relevantDiagnostics: [] };
		}

		const filterDiagnosticsAndLog = (diagnostics: Diagnostic[], message: string, filterFn: (diagnostics: Diagnostic[]) => Diagnostic[]): Diagnostic[] => {
			const diagnosticsAfter = filterFn(diagnostics);
			const diagnosticsDiff = diagnostics.filter(diagnostic => !diagnosticsAfter.includes(diagnostic));
			if (diagnosticsDiff.length > 0) {
				logList(message, diagnosticsDiff, logContext, this._tracer);
			}
			return diagnosticsAfter;
		};

		const language = workspaceDocument.languageId.get();
		const providers = this._diagnosticsCompletionProviders.get();

		let relevantDiagnostics = [...availableDiagnostics];
		relevantDiagnostics = filterDiagnosticsAndLog(relevantDiagnostics, 'Filtered by provider', ds => ds.filter(diagnostic => providers.some(provider => provider.providesCompletionsForDiagnostic(diagnostic, language, cursor))));
		relevantDiagnostics = filterDiagnosticsAndLog(relevantDiagnostics, 'Filtered by recent acceptance', ds => ds.filter(diagnostic => !this._hasDiagnosticRecentlyBeenAccepted(diagnostic)));
		relevantDiagnostics = filterDiagnosticsAndLog(relevantDiagnostics, 'Filtered by no recent edit', ds => this._filterDiagnosticsByRecentEditNearby(ds, workspaceDocument));

		return { availableDiagnostics, relevantDiagnostics };
	}

	private async _runCompletionHandler(workspaceDocument: IVSCodeObservableDocument, diagnosticsSorted: Diagnostic[], allDiagnostics: Diagnostic[], cursor: Position, log: DiagnosticInlineEditRequestLogContext, token: CancellationToken): Promise<IDiagnosticsCompletionState> {
		const telemetryBuilder = new DiagnosticsCompletionHandlerTelemetry();

		let completionItem = null;
		try {
			this._tracer.trace('Running diagnostics inline completion handler');
			completionItem = await this._getCompletionFromDiagnostics(workspaceDocument, diagnosticsSorted, cursor, log, token, telemetryBuilder);
		} catch (error) {
			log.setError(error);
		}

		// Distance to the closest diagnostic which is not supported by any provider
		const allNoneSupportedDiagnostics = allDiagnostics.filter(diagnostic => !diagnosticsSorted.includes(diagnostic));
		telemetryBuilder.setDistanceToUnknownDiagnostic(distanceToClosestDiagnostic(allNoneSupportedDiagnostics, cursor));

		// Distance to the closest none result diagnostic
		const allAlternativeDiagnostics = allDiagnostics.filter(diagnostic => !completionItem || !completionItem.diagnostic.equals(diagnostic));
		telemetryBuilder.setDistanceToAlternativeDiagnostic(distanceToClosestDiagnostic(allAlternativeDiagnostics, cursor));

		if (completionItem) {
			const hasDiagnosticForSameRange = allAlternativeDiagnostics.some(diagnostic => completionItem.diagnostic.range.equalsRange(diagnostic.range));
			telemetryBuilder.setHasAlternativeDiagnosticForSameRange(hasDiagnosticForSameRange);
		}

		// Todo: this should be handled on a lower level
		if (completionItem instanceof ImportDiagnosticCompletionItem) {
			telemetryBuilder.setImportTelemetry(completionItem);
		}

		return { completionItem, logContext: log, telemetryBuilder: telemetryBuilder };
	}

	getCurrentState(docId: DocumentId): DiagnosticCompletionState {
		const currentState = this._worker.getCurrentResult();

		const workspaceDocument = this._workspace.getDocument(docId);
		if (!workspaceDocument) { return { item: undefined, telemetry: new DiagnosticsCompletionHandlerTelemetry().addDroppedReason('WorkspaceDocumentNotFound').build(), logContext: undefined }; }

		if (currentState === NoResultReason.HasNotRunYet) {
			return { item: undefined, telemetry: new DiagnosticsCompletionHandlerTelemetry().build(), logContext: undefined };
		}
		if (currentState === NoResultReason.WorkInProgress) {
			return { item: undefined, telemetry: new DiagnosticsCompletionHandlerTelemetry().addDroppedReason(NoResultReason.WorkInProgress).build(), logContext: undefined };
		}

		const { telemetryBuilder, completionItem, logContext } = currentState;
		if (!completionItem) {
			return { item: undefined, telemetry: telemetryBuilder.build(), logContext };
		}

		if (!this._isCompletionItemValid(completionItem, workspaceDocument, currentState.logContext, telemetryBuilder)) {
			return { item: undefined, telemetry: telemetryBuilder.build(), logContext };
		}

		if (completionItem.documentId !== docId) {
			logContext.addLog("Dropped: wrong-document");
			return { item: undefined, telemetry: telemetryBuilder.addDroppedReason('wrong-document').build(), logContext };
		}

		log("following known diagnostics:\n" + this._currentDiagnostics.toString(), undefined, this._tracer);

		return { item: completionItem, telemetry: telemetryBuilder.build(), logContext };
	}

	async getNextUpdatedState(docId: DocumentId, token: CancellationToken): Promise<DiagnosticCompletionState> {
		const disposables = new DisposableStore();

		await new Promise<void>((resolve) => {
			disposables.add(token.onCancellationRequested(() => resolve()));
			disposables.add(this._worker.onDidChange(() => resolve()));
		});

		disposables.dispose();

		return this.getCurrentState(docId);
	}

	private async _getCompletionFromDiagnostics(workspaceDocument: IVSCodeObservableDocument, diagnosticsSorted: Diagnostic[], pos: Position, logContext: DiagnosticInlineEditRequestLogContext, token: CancellationToken, tb: DiagnosticsCompletionHandlerTelemetry): Promise<DiagnosticCompletionItem | null> {
		if (diagnosticsSorted.length === 0) {
			log(`No diagnostics available for document ${workspaceDocument.id.toString()}`, logContext, this._tracer);
			return null;
		}

		const diagnosticsCompletionItems = await this._fetchDiagnosticsBasedCompletions(workspaceDocument, diagnosticsSorted, pos, logContext, token);

		return diagnosticsCompletionItems.find(item => this._isCompletionItemValid(item, workspaceDocument, logContext, tb)) ?? null;
	}

	private async _fetchDiagnosticsBasedCompletions(workspaceDocument: IVSCodeObservableDocument, sortedDiagnostics: Diagnostic[], pos: Position, logContext: DiagnosticInlineEditRequestLogContext, token: CancellationToken): Promise<DiagnosticCompletionItem[]> {
		const providers = this._diagnosticsCompletionProviders.get();

		const providerResults = await Promise.all(providers.map(provider =>
			provider.provideDiagnosticCompletionItem(workspaceDocument, sortedDiagnostics, pos, logContext, token)
		));

		return providerResults.filter(item => !!item) as DiagnosticCompletionItem[];
	}

	// Handle Acceptance and rejection of diagnostics completion items

	public handleEndOfLifetime(completionItem: DiagnosticCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
		const provider = this._diagnosticsCompletionProviders.get().find(p => p.providerName === completionItem.providerName);
		if (!provider) {
			throw new BugIndicatingError('No provider found for completion item');
		}

		if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Rejected) {
			this._rejectDiagnosticCompletion(provider, completionItem);
		} else if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
			this._acceptDiagnosticCompletion(provider, completionItem);
		}
	}

	private _lastAcceptedDiagnostic: { diagnostic: Diagnostic; time: number } | undefined = undefined;
	private _acceptDiagnosticCompletion(provider: IDiagnosticCompletionProvider, item: DiagnosticCompletionItem): void {
		this._lastAcceptedDiagnostic = { diagnostic: item.diagnostic, time: Date.now() };
	}

	private _rejectDiagnosticCompletion(provider: IDiagnosticCompletionProvider, item: DiagnosticCompletionItem): void {
		this._rejectionCollector.reject(item.documentId, item.toOffsetEdit());

		provider.completionItemRejected?.(item);
	}

	// Filters

	private _isCompletionItemValid(item: DiagnosticCompletionItem, workspaceDocument: IObservableDocument, logContext: DiagnosticInlineEditRequestLogContext, tb: DiagnosticsCompletionHandlerTelemetry): boolean {
		if (!item.diagnostic.isValid()) {
			log('Diagnostic completion item is no longer valid', logContext, this._tracer);
			tb.addDroppedReason('no-longer-valid', item);
			logContext.markToBeLogged();
			return false;
		}

		if (this._isDiagnosticCompletionRejected(item)) {
			log('Diagnostic completion item has been rejected before', logContext, this._tracer);
			tb.addDroppedReason('recently-rejected', item);
			logContext.markToBeLogged();
			return false;
		}

		if (this._isUndoRecentEdit(item)) {
			log('Diagnostic completion item is an undo operation', logContext, this._tracer);
			tb.addDroppedReason('undo-operation', item);
			logContext.markToBeLogged();
			return false;
		}

		if (this._hasDiagnosticRecentlyBeenAccepted(item.diagnostic)) {
			log('Completion item fixing the diagnostic has been accepted recently', logContext, this._tracer);
			tb.addDroppedReason('recently-accepted', item);
			logContext.markToBeLogged();
			return false;
		}

		if (this._hasRecentlyBeenAddedWithoutNES(item)) {
			log('Diagnostic has been fixed without NES recently', logContext, this._tracer);
			tb.addDroppedReason('recently-added-without-nes', item);
			logContext.markToBeLogged();
			return false;
		}

		const provider = this._diagnosticsCompletionProviders.get().find(p => p.providerName === item.providerName);
		if (provider && provider.isCompletionItemStillValid && !provider.isCompletionItemStillValid(item, workspaceDocument)) {
			log(`${provider.providerName}: Completion item is no longer valid`, logContext, this._tracer);
			tb.addDroppedReason(`${provider.providerName}-no-longer-valid`, item);
			logContext.markToBeLogged();
			return false;
		}

		return true;
	}

	private _isDiagnosticCompletionRejected(diagnostic: DiagnosticCompletionItem): boolean {
		return this._rejectionCollector.isRejected(diagnostic.documentId, diagnostic.toOffsetEdit());
	}

	private _hasRecentlyBeenAddedWithoutNES(item: DiagnosticCompletionItem): boolean {
		const recentEdits = this._workspaceDocumentEditHistory.getNRecentEdits(item.documentId, 5)?.edits;
		if (!recentEdits) {
			return false;
		}

		const offsetEdit = item.toOffsetEdit();
		return recentEdits.replacements.some(edit => edit.replaceRange.intersectsOrTouches(offsetEdit.replaceRange));
	}

	private _hasDiagnosticRecentlyBeenAccepted(diagnostic: Diagnostic): boolean {
		if (!this._lastAcceptedDiagnostic || this._lastAcceptedDiagnostic.time + 1000 < Date.now()) {
			return false;
		}
		return this._lastAcceptedDiagnostic.diagnostic.equals(diagnostic);
	}

	private _isUndoRecentEdit(diagnostic: DiagnosticCompletionItem): boolean {
		const documentHistory = this._workspaceDocumentEditHistory.getRecentEdits(diagnostic.documentId);
		if (!documentHistory) {
			return false;
		}

		return diagnosticWouldUndoUserEdit(diagnostic, documentHistory.before, documentHistory.after, Edits.single(documentHistory.edits));
	}

	private _filterDiagnosticsByRecentEditNearby(diagnostics: Diagnostic[], document: IVSCodeObservableDocument): Diagnostic[] {
		const recentEdits = this._workspaceDocumentEditHistory.getRecentEdits(document.id)?.edits;
		if (!recentEdits) {
			return [];
		}

		const transformer = document.value.get().getTransformer();

		return diagnostics.filter(diagnostic => {
			const currentOffsetRange = transformer.getOffsetRange(diagnostic.range);
			const newRanges = recentEdits.getNewRanges();

			const potentialIntersection = findFirstMonotonous(newRanges, (r) => r.endExclusive >= currentOffsetRange.start);
			return potentialIntersection?.intersectsOrTouches(currentOffsetRange);
		});
	}
}

function diagnosticWouldUndoUserEdit(diagnostic: DiagnosticCompletionItem, documentBefore: StringText, documentAfter: StringText, edits: Edits): boolean {

	const currentEdit = diagnostic.toOffsetEdit().toEdit();
	const ourInformationDelta = getInformationDelta(documentAfter.value, currentEdit);

	let recentInformationDelta = new InformationDelta();
	let doc = documentBefore.value;
	for (const edit of edits.edits) {
		recentInformationDelta = recentInformationDelta.combine(getInformationDelta(doc, edit));
		doc = edit.apply(doc);
	}

	if (recentInformationDelta.isUndoneBy(ourInformationDelta)) {
		return true;
	}

	return false;
}

function isEditorFromEditorGrid(editor: vscode.TextEditor): boolean {
	return editor.viewColumn !== undefined;
}

const enum NoResultReason {
	WorkInProgress = 'work-in-progress',
	HasNotRunYet = 'has-not-run-yet'
}

class AsyncWorker<T extends {}> extends Disposable {
	private readonly _taskQueue: ThrottledDelayer<void>;

	private readonly _onDidChange = this._register(new vscode.EventEmitter<T>());
	readonly onDidChange = this._onDidChange.event;

	private _currentTokenSource: CancellationTokenSource | undefined = undefined;
	private _activeWorkPromise: Promise<void> | undefined = undefined;

	private __currentResult: T | undefined = undefined;
	private get _currentResult(): T | undefined {
		return this.__currentResult;
	}
	private set _currentResult(value: T) {
		if (!this._taskQueue.isTriggered() && (this.__currentResult === undefined || !this._equals(value, this.__currentResult))) {
			this._onDidChange.fire(value);
		}

		this.__currentResult = value;
	}

	constructor(delay: number, private readonly _equals: (a: T, b: T) => boolean) {
		super();

		this._taskQueue = new ThrottledDelayer<void>(delay);
	}

	async schedule(fn: (token: CancellationToken) => Promise<T>): Promise<void> {
		const activePromise = this._doSchedule(fn);
		this._activeWorkPromise = activePromise;

		await activePromise;

		if (this._activeWorkPromise === activePromise) {
			this._activeWorkPromise = undefined;
		}
	}

	private async _doSchedule(fn: (token: CancellationToken) => Promise<T>): Promise<void> {
		this._currentTokenSource?.dispose(true);
		this._currentTokenSource = new CancellationTokenSource();
		const token = this._currentTokenSource.token;

		await this._taskQueue.trigger(async () => {
			if (token.isCancellationRequested) {
				return;
			}

			const result = await fn(token);

			if (token.isCancellationRequested) {
				return;
			}

			this._currentResult = result;
		});
	}

	// Get the active result if there is one currently
	// Return undefined if there is currently work being done
	getCurrentResult(): T | NoResultReason {
		if (this._currentResult === undefined) {
			return NoResultReason.HasNotRunYet;
		}

		if (this._activeWorkPromise !== undefined) {
			return NoResultReason.WorkInProgress;
		}

		return this._currentResult;
	}

	override dispose(): void {
		if (this._currentTokenSource) {
			this._currentTokenSource.dispose();
		}
		super.dispose();
	}
}

interface IDiagnosticsCompletionTelemetry {
	droppedReasons: string[];
	alternativeImportsCount?: number;
	hasExistingSameFileImport?: boolean;
	isLocalImport?: boolean;
	distanceToUnknownDiagnostic?: number;
	distanceToAlternativeDiagnostic?: number;
	hasAlternativeDiagnosticForSameRange?: boolean;
}

class DiagnosticsCompletionHandlerTelemetry {
	private _droppedReasons: string[] = [];

	addDroppedReason(reason: string, item?: DiagnosticCompletionItem): this {
		if (item instanceof AnyDiagnosticCompletionItem) {
			return this; // Do not track dropped reasons for "any" items
		}

		this._droppedReasons.push(item ? `${item.type}:${reason}` : reason);
		return this;
	}

	private _distanceToAlternativeDiagnostic: number | undefined;
	setDistanceToAlternativeDiagnostic(distance: number | undefined): this {
		this._distanceToAlternativeDiagnostic = distance;
		return this;
	}

	private _distanceToUnknownDiagnostic: number | undefined;
	setDistanceToUnknownDiagnostic(distance: number | undefined): this {
		this._distanceToUnknownDiagnostic = distance;
		return this;
	}

	private _hasAlternativeDiagnosticForSameRange: boolean | undefined;
	setHasAlternativeDiagnosticForSameRange(has: boolean | undefined): this {
		this._hasAlternativeDiagnosticForSameRange = has;
		return this;
	}

	private _alternativeImportsCount: number | undefined;
	private _hasExistingSameFileImport: boolean | undefined;
	private _isLocalImport: boolean | undefined;

	setImportTelemetry(item: ImportDiagnosticCompletionItem): this {
		this._alternativeImportsCount = item.alternativeImportsCount;
		this._hasExistingSameFileImport = item.hasExistingSameFileImport;
		this._isLocalImport = item.isLocalImport;
		return this;
	}

	build(): IDiagnosticsCompletionTelemetry {
		return {
			droppedReasons: this._droppedReasons,
			alternativeImportsCount: this._alternativeImportsCount,
			hasExistingSameFileImport: this._hasExistingSameFileImport,
			isLocalImport: this._isLocalImport,
			distanceToUnknownDiagnostic: this._distanceToUnknownDiagnostic,
			distanceToAlternativeDiagnostic: this._distanceToAlternativeDiagnostic,
			hasAlternativeDiagnosticForSameRange: this._hasAlternativeDiagnosticForSameRange
		};
	}
}