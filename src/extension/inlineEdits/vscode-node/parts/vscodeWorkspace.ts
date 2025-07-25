/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Diagnostic, DiagnosticSeverity, EndOfLine, languages, NotebookCell, NotebookDocument, Range, TextDocument, TextDocumentChangeEvent, TextDocumentContentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { DiagnosticData } from '../../../../platform/inlineEdits/common/dataTypes/diagnosticData';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { EditReason } from '../../../../platform/inlineEdits/common/editReason';
import { IObservableDocument, ObservableWorkspace, StringEditWithReason } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { createAlternativeNotebookDocument, IAlternativeNotebookDocument, toAltDiagnostics, toAltNotebookCellChangeEdit, toAltNotebookChangeEdit } from '../../../../platform/notebook/common/alternativeNotebookTextDocument';
import { getDefaultLanguage } from '../../../../platform/notebook/common/helpers';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { getLanguage } from '../../../../util/common/languages';
import { findNotebook, isNotebookCellOrNotebookChatInput } from '../../../../util/common/notebooks';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { diffMaps } from '../../../../util/vs/base/common/collections';
import { onUnexpectedError } from '../../../../util/vs/base/common/errors';
import { Disposable, DisposableStore, IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../../util/vs/base/common/network';
import { autorun, derived, IObservable, IReader, ISettableObservable, mapObservableArrayCached, observableFromEvent, observableValue, transaction } from '../../../../util/vs/base/common/observableInternal';
import { isDefined } from '../../../../util/vs/base/common/types';
import { URI } from '../../../../util/vs/base/common/uri';
import { StringEdit, StringReplacement } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';

export class VSCodeWorkspace extends ObservableWorkspace implements IDisposable {
	private readonly _openDocuments = observableValue<readonly IVSCodeObservableDocument[], { added: readonly IVSCodeObservableDocument[]; removed: readonly IVSCodeObservableDocument[] }>(this, []);
	public readonly openDocuments = this._openDocuments;
	private readonly _store = new DisposableStore();
	private readonly _filter: DocumentFilter;
	private readonly _useAlternativeNotebookFormat: boolean;
	constructor(
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IInstantiationService private readonly _instaService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
		super();

		this._filter = this._instaService.createInstance(DocumentFilter);

		this._useAlternativeNotebookFormat = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.UseAlternativeNESNotebookFormat, this._experimentationService);
		const config = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.VerifyTextDocumentChanges, this._experimentationService);
		this._store.add(autorun(reader => {
			if (config.read(reader)) {
				reader.store.add(this._instaService.createInstance(VerifyTextDocumentChanges));
			}
		}));

		let lastDocs: Map<DocumentId, IVSCodeObservableDocument> = new Map();
		this._store.add(autorun(reader => {
			// Manually copy over the documents to get the delta
			const curDocs = this._obsDocsByDocId.read(reader);
			const diff = diffMaps(lastDocs, curDocs);
			lastDocs = curDocs;

			this._openDocuments.set([...curDocs.values()], undefined, {
				added: diff.added,
				removed: diff.removed,
			});
		}));

		this._store.add(workspace.onDidChangeTextDocument(e => {
			const doc = this._getDocumentByDocumentAndUpdateShouldTrack(e.document.uri);
			if (!doc) {
				return;
			}
			if (doc.kind === 'textDocument') {
				const edit = editFromTextDocumentContentChangeEvents(e.contentChanges);
				const editWithReason = new StringEditWithReason(edit.replacements, EditReason.create(e.detailedReason?.metadata as any));
				transaction(tx => {
					doc.languageId.set(LanguageId.create(e.document.languageId), tx);
					doc.value.set(stringValueFromDoc(e.document), tx, editWithReason);
					doc.version.set(e.document.version, tx);
				});
			} else {
				const edit = toAltNotebookCellChangeEdit(doc.altNotebook, e.document, e.contentChanges);
				doc.altNotebook.applyCellChanges(e.document, e.contentChanges);
				const editWithReason = new StringEditWithReason(edit.replacements, EditReason.create(e.detailedReason?.metadata as any));
				transaction(tx => {
					doc.value.set(new StringText(doc.altNotebook.getText()), tx, editWithReason);
					doc.version.set(doc.notebook.version, tx);
				});
			}
		}));

		this._store.add(workspace.onDidChangeNotebookDocument(e => {
			const doc = this._getDocumentByDocumentAndUpdateShouldTrack(e.notebook.uri);
			if (!doc || !e.contentChanges.length || doc.kind !== 'notebookDocument') {
				return;
			}
			const edit = toAltNotebookChangeEdit(doc.altNotebook, e.contentChanges);
			if (!edit) {
				return;
			}
			doc.altNotebook.applyNotebookChanges(e.contentChanges);
			const editWithReason = new StringEditWithReason(edit.replacements, EditReason.unknown);
			transaction(tx => {
				doc.value.set(new StringText(doc.altNotebook.getText()), tx, editWithReason);
				doc.version.set(doc.notebook.version, tx);
			});
		}));

		this._store.add(window.onDidChangeTextEditorSelection(e => {
			const doc = this._getDocumentByDocumentAndUpdateShouldTrack(e.textEditor.document.uri);
			if (!doc) {
				return;
			}
			if (doc.kind === 'textDocument') {
				doc.selection.set(e.selections.map(s => rangeToOffsetRange(s, e.textEditor.document)), undefined);
			} else {
				doc.selection.set(this.getNotebookSelections(doc.notebook, e.textEditor), undefined);
			}
		}));

		this._store.add(window.onDidChangeTextEditorVisibleRanges(e => {
			const doc = this._getDocumentByDocumentAndUpdateShouldTrack(e.textEditor.document.uri);
			if (!doc) {
				return;
			}
			if (doc.kind === 'textDocument') {
				doc.visibleRanges.set(e.visibleRanges.map(r => rangeToOffsetRange(r, e.textEditor.document)), undefined);
			} else {
				doc.visibleRanges.set(this.getNotebookVisibleRanges(doc.notebook), undefined);
			}
		}));

		this._store.add(languages.onDidChangeDiagnostics(e => {
			e.uris.forEach(uri => {
				const document = this._getDocumentByDocumentAndUpdateShouldTrack(uri);
				if (!document) {
					return;
				}
				const diagnostics = document.kind === 'textDocument' ? this._createTextDocumentDiagnosticData(document.textDocument) : this._createNotebookDiagnosticData(document.altNotebook);
				document.diagnostics.set(diagnostics, undefined);
			});
		}));
	}

	public dispose(): void {
		this._store.dispose();
	}

	private readonly _obsDocsByDocId = derived(this, reader => {
		const textDocs = this._textDocsWithShouldTrackFlag.read(reader);
		const obsDocs = textDocs.map(d => d.obsDoc.read(reader)).filter(isDefined);
		const map: Map<DocumentId, VSCodeObservableTextDocument | VSCodeObservableNotebookDocument> = new Map(obsDocs.map(d => [d.id, d]));
		const notebookDocs = this._notebookDocsWithShouldTrackFlag.read(reader);
		const obsNotebookDocs = notebookDocs.map(d => d.obsDoc.read(reader)).filter(isDefined);
		obsNotebookDocs.forEach(d => map.set(d.id, d));

		return map;
	});

	private getTextDocuments() {
		return getTextDocuments(this._useAlternativeNotebookFormat);
	}
	private readonly _vscodeTextDocuments: IObservable<readonly TextDocument[]> = this.getTextDocuments();
	private readonly _textDocsWithShouldTrackFlag = mapObservableArrayCached(this, this._vscodeTextDocuments, (doc, store) => {
		const shouldTrack = observableValue<boolean>(this, false);
		const updateShouldTrack = () => {
			// @ulugbekna: not sure if invoking `isCopilotIgnored` on every textDocument-edit event is a good idea
			// 	also not sure if we should be enforcing local copilot-ignore rules (vs only remote-exclusion rules)
			this._filter.isTrackingEnabled(doc).then(v => {
				shouldTrack.set(v, undefined);
			}).catch(e => {
				onUnexpectedError(e);
			});
		};
		const obsDoc = derived(this, reader => {
			if (!shouldTrack.read(reader)) {
				return undefined;
			}

			const documentId = DocumentId.create(doc.uri.toString());
			const openedTextEditor = window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
			const selections = openedTextEditor?.selections.map(s => rangeToOffsetRange(s, doc));
			const visibleRanges = openedTextEditor?.visibleRanges.map(r => rangeToOffsetRange(r, doc));
			const diagnostics = this._createTextDocumentDiagnosticData(doc);
			const document = new VSCodeObservableTextDocument(documentId, stringValueFromDoc(doc), doc.version, selections ?? [], visibleRanges ?? [], LanguageId.create(doc.languageId), diagnostics, doc);
			return document;
		}).recomputeInitiallyAndOnChange(store);

		updateShouldTrack();
		return {
			doc,
			updateShouldTrack,
			obsDoc,
		};
	});

	private getNotebookDocuments() {
		if (!this._useAlternativeNotebookFormat) {
			return observableValue('', []);
		}
		return getNotebookDocuments();
	}
	private readonly _vscodeNotebookDocuments: IObservable<readonly NotebookDocument[]> = this.getNotebookDocuments();
	private readonly _altNotebookDocs = new WeakMap<NotebookDocument, IAlternativeNotebookDocument>();
	private getAltNotebookDocument(doc: NotebookDocument): IAlternativeNotebookDocument {
		let altNotebook = this._altNotebookDocs.get(doc);
		if (!altNotebook) {
			altNotebook = createAlternativeNotebookDocument(doc, true);
			this._altNotebookDocs.set(doc, altNotebook);
		}
		return altNotebook;
	}
	private readonly _notebookDocsWithShouldTrackFlag = mapObservableArrayCached(this, this._vscodeNotebookDocuments, (doc, store) => {
		const shouldTrack = observableValue<boolean>(this, false);
		const updateShouldTrack = () => {
			// @ulugbekna: not sure if invoking `isCopilotIgnored` on every textDocument-edit event is a good idea
			// 	also not sure if we should be enforcing local copilot-ignore rules (vs only remote-exclusion rules)
			this._filter.isTrackingEnabled(doc).then(v => {
				shouldTrack.set(v, undefined);
			}).catch(e => {
				onUnexpectedError(e);
			});
		};
		const obsDoc = derived(this, reader => {
			if (!shouldTrack.read(reader)) {
				return undefined;
			}
			const altNotebook = this.getAltNotebookDocument(doc);
			const documentId = DocumentId.create(doc.uri.toString());
			const selections = this.getNotebookSelections(doc);
			const visibleRanges = this.getNotebookVisibleRanges(doc);
			const diagnostics = this._createNotebookDiagnosticData(altNotebook);
			const language = getLanguage(getDefaultLanguage(altNotebook.notebook)).languageId;
			const document = new VSCodeObservableNotebookDocument(documentId, new StringText(altNotebook.getText()), doc.version, selections ?? [], visibleRanges ?? [], LanguageId.create(language), diagnostics, doc, altNotebook);
			return document;
		}).recomputeInitiallyAndOnChange(store);

		updateShouldTrack();
		return {
			doc,
			updateShouldTrack,
			obsDoc,
		};
	});

	private getNotebookSelections(doc: NotebookDocument, activeCellEditor?: TextEditor) {
		const altNotebook = this.getAltNotebookDocument(doc);
		const visibleTextEditors = new Map(window.visibleTextEditors.map(e => [e.document, e]));
		const cellTextEditors = coalesce(doc.getCells().map(cell => visibleTextEditors.has(cell.document) ? [cell, visibleTextEditors.get(cell.document)!] as const : undefined));
		let selections = cellTextEditors.flatMap(e => altNotebook.toAltOffsetRange(e[0], e[1].selections));
		// We can have multiple selections, so we return all of them.
		// But the first selection is the most important one, as it represents the cursor position.
		// As notebooks have multiple cells, and each cell can have its own selection,
		// We should focus on the active cell to determine the cursor position.
		const selectedCellRange = window.activeNotebookEditor?.selection;
		const selectedCell = activeCellEditor ? altNotebook.getCell(activeCellEditor.document) : (selectedCellRange && selectedCellRange.start < doc.cellCount ? doc.cellAt(selectedCellRange.start) : undefined);
		const selectedCellEditor = selectedCell ? visibleTextEditors.get(selectedCell.document) : undefined;
		if (selectedCellEditor && selectedCell) {
			const primarySelections = altNotebook.toAltOffsetRange(selectedCell, selectedCellEditor.selections);
			// Remove the selections related to active cell from the list of selections and add it to the front.
			selections = selections.filter(s => !primarySelections.some(ps => ps.equals(s)));
			selections.splice(0, 0, ...primarySelections);
		}
		return selections;
	}

	private getNotebookVisibleRanges(doc: NotebookDocument) {
		const altNotebook = this.getAltNotebookDocument(doc);
		const visibleTextEditors = new Map(window.visibleTextEditors.map(e => [e.document, e]));
		const cellTextEditors = coalesce(doc.getCells().map(cell => visibleTextEditors.has(cell.document) ? [cell, visibleTextEditors.get(cell.document)!] as const : undefined));
		return cellTextEditors.flatMap(e => altNotebook.toAltOffsetRange(e[0], e[1].visibleRanges));
	}

	private _getDocumentByDocumentAndUpdateShouldTrack(uri: URI): VSCodeObservableTextDocument | VSCodeObservableNotebookDocument | undefined {
		const internalDoc = this._getInternalDocument(uri);
		if (!internalDoc) {
			return undefined;
		}
		internalDoc.updateShouldTrack();
		return internalDoc.obsDoc.get();
	}

	private _getInternalDocument(uri: Uri, reader?: IReader) {
		const document = this._obsDocsWithUpdateIgnored.read(reader).get(uri.toString());
		return document;
	}

	private _createTextDocumentDiagnosticData(document: TextDocument) {
		return languages.getDiagnostics(document.uri).map(d => this._createDiagnosticData(d, document)).filter(isDefined);
	}

	private _createDiagnosticData(diagnostic: Diagnostic, doc: TextDocument): DiagnosticData | undefined {
		if (!diagnostic.source || (diagnostic.severity !== DiagnosticSeverity.Error && diagnostic.severity !== DiagnosticSeverity.Warning)) {
			return undefined;
		}
		const diag: DiagnosticData = new DiagnosticData(
			doc.uri,
			diagnostic.message,
			diagnostic.severity === DiagnosticSeverity.Error ? 'error' : 'warning',
			rangeToOffsetRange(diagnostic.range, doc)
		);
		return diag;
	}

	private _createNotebookDiagnosticData(altNotebook: IAlternativeNotebookDocument) {
		return coalesce(altNotebook.notebook.getCells().flatMap(c => languages.getDiagnostics(c.document.uri).map(d => this._createNotebookCellDiagnosticData(d, altNotebook, c.document))));
	}

	private _createNotebookCellDiagnosticData(diagnostic: Diagnostic, altNotebook: IAlternativeNotebookDocument, doc: TextDocument): DiagnosticData | undefined {
		if (!diagnostic.source || (diagnostic.severity !== DiagnosticSeverity.Error && diagnostic.severity !== DiagnosticSeverity.Warning)) {
			return undefined;
		}
		const cell = altNotebook.getCell(doc);
		const offsetRanges = cell ? altNotebook.toAltOffsetRange(cell, [diagnostic.range]) : [];
		if (!cell || !offsetRanges.length) {
			return undefined;
		}
		const diag: DiagnosticData = new DiagnosticData(
			altNotebook.notebook.uri,
			diagnostic.message,
			diagnostic.severity === DiagnosticSeverity.Error ? 'error' : 'warning',
			offsetRanges[0]
		);
		return diag;
	}

	private readonly _obsDocsWithUpdateIgnored = derived(this, reader => {
		const docs = this._textDocsWithShouldTrackFlag.read(reader);
		const map: Map<string, {
			doc: TextDocument;
			updateShouldTrack: () => void;
			obsDoc: IObservable<VSCodeObservableTextDocument | undefined>;
		} | {
			doc: NotebookDocument;
			updateShouldTrack: () => void;
			obsDoc: IObservable<VSCodeObservableNotebookDocument | undefined>;
		}> = new Map(docs.map(d => [d.doc.uri.toString(), d]));
		const notebookDocs = this._notebookDocsWithShouldTrackFlag.read(reader);
		notebookDocs.forEach(d => {
			map.set(d.doc.uri.toString(), d);
			d.doc.getCells().forEach(cell => map.set(cell.document.uri.toString(), d));
		});
		return map;
	});

	/**
	 * Returns undefined for documents that are not tracked (e.g. filtered out).
	*/
	public getDocumentByTextDocument(doc: TextDocument, reader?: IReader): IVSCodeObservableDocument | undefined {
		this._store.assertNotDisposed();

		const internalDoc = this._getInternalDocument(doc.uri, reader);
		if (!internalDoc) {
			return undefined;
		}
		return internalDoc.obsDoc.get();
	}

	public getWorkspaceRoot(documentId: DocumentId): URI | undefined {
		let uri = documentId.toUri();
		if (uri.scheme === Schemas.vscodeNotebookCell) {
			const notebook = findNotebook(uri, this._workspaceService.notebookDocuments);
			if (notebook) {
				uri = notebook.uri;
			}
		}
		return workspace.getWorkspaceFolder(uri)?.uri;
	}
}

export interface IVSCodeObservableTextDocument extends IObservableDocument {
	kind: 'textDocument';
	readonly textDocument: TextDocument;
	fromOffsetRange(range: OffsetRange): Range;
}

abstract class AbstractVSCodeObservableDocument {
	public readonly value: ISettableObservable<StringText, StringEditWithReason>;
	public readonly version: ISettableObservable<number>;
	public readonly selection: ISettableObservable<readonly OffsetRange[]>;
	public readonly visibleRanges: ISettableObservable<readonly OffsetRange[]>;
	public readonly languageId: ISettableObservable<LanguageId>;
	public readonly diagnostics: ISettableObservable<readonly DiagnosticData[]>;

	constructor(
		public readonly id: DocumentId,
		value: StringText,
		versionId: number,
		selection: readonly OffsetRange[],
		visibleRanges: readonly OffsetRange[],
		languageId: LanguageId,
		diagnostics: DiagnosticData[]
	) {
		this.value = observableValue(this, value);
		this.version = observableValue(this, versionId);
		this.selection = observableValue(this, selection);
		this.visibleRanges = observableValue(this, visibleRanges);
		this.languageId = observableValue(this, languageId);
		this.diagnostics = observableValue(this, diagnostics);
	}
}


class VSCodeObservableTextDocument extends AbstractVSCodeObservableDocument implements IVSCodeObservableTextDocument {
	public kind: 'textDocument' = 'textDocument';

	constructor(
		id: DocumentId,
		value: StringText,
		versionId: number,
		selection: readonly OffsetRange[],
		visibleRanges: readonly OffsetRange[],
		languageId: LanguageId,
		diagnostics: DiagnosticData[],
		public readonly textDocument: TextDocument,
	) {
		super(id, value, versionId, selection, visibleRanges, languageId, diagnostics);
	}

	fromOffsetRange(range: OffsetRange): Range {
		return new Range(
			this.textDocument.positionAt(range.start),
			this.textDocument.positionAt(range.endExclusive)
		);
	}
}

export interface IVSCodeObservableNotebookDocument extends IObservableDocument {
	kind: 'notebookDocument';
	readonly notebook: NotebookDocument;
	fromOffsetRange(range: OffsetRange): [NotebookCell, Range][];
	fromRange(range: Range): [NotebookCell, Range][];
	projectRange(cell: NotebookCell, range: readonly Range[]): Range[];
	projectDiagnostics(cell: NotebookCell, diagnostics: readonly Diagnostic[]): Diagnostic[];
}

class VSCodeObservableNotebookDocument extends AbstractVSCodeObservableDocument implements IVSCodeObservableNotebookDocument {
	public kind: 'notebookDocument' = 'notebookDocument';

	constructor(
		id: DocumentId,
		value: StringText,
		versionId: number,
		selection: readonly OffsetRange[],
		visibleRanges: readonly OffsetRange[],
		languageId: LanguageId,
		diagnostics: DiagnosticData[],
		public readonly notebook: NotebookDocument,
		public readonly altNotebook: IAlternativeNotebookDocument,
	) {
		super(id, value, versionId, selection, visibleRanges, languageId, diagnostics);
	}

	fromOffsetRange(range: OffsetRange): [NotebookCell, Range][] {
		return this.altNotebook.fromAltOffsetRange(range);
	}
	fromRange(range: Range): [NotebookCell, Range][] {
		return this.altNotebook.fromAltRange(range);
	}
	projectRange(cell: NotebookCell, range: readonly Range[]): Range[] {
		return this.altNotebook.toAltRange(cell, range);
	}
	projectDiagnostics(cell: NotebookCell, diagnostics: readonly Diagnostic[]): Diagnostic[] {
		return toAltDiagnostics(this.altNotebook, cell, diagnostics);
	}
}

export type IVSCodeObservableDocument = IVSCodeObservableTextDocument | IVSCodeObservableNotebookDocument;

function rangeToOffsetRange(range: Range, doc: TextDocument): OffsetRange {
	return new OffsetRange(doc.offsetAt(range.start), doc.offsetAt(range.end));
}

function getTextDocuments(excludeNotebookCells: boolean): IObservable<readonly TextDocument[]> {
	return observableFromEvent(undefined, e => {
		const d1 = workspace.onDidOpenTextDocument(e);
		const d2 = workspace.onDidCloseTextDocument(e);
		return {
			dispose: () => {
				d1.dispose();
				d2.dispose();
			}
		};
	}, () => excludeNotebookCells ? workspace.textDocuments.filter(doc => doc.uri.scheme !== Schemas.vscodeNotebookCell) : workspace.textDocuments);
}

function getNotebookDocuments(): IObservable<readonly NotebookDocument[]> {
	return observableFromEvent(undefined, e => {
		const d1 = workspace.onDidOpenNotebookDocument(e);
		const d2 = workspace.onDidCloseNotebookDocument(e);
		return {
			dispose: () => {
				d1.dispose();
				d2.dispose();
			}
		};
	}, () => workspace.notebookDocuments);
}

function isTextDocument(doc: TextDocument | NotebookDocument): doc is TextDocument {
	const notebook = doc as NotebookDocument;
	return !notebook.notebookType;
}

export class DocumentFilter {
	private readonly _enabledLanguagesObs;
	private readonly _ignoreCompletionsDisablement;

	constructor(
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		this._enabledLanguagesObs = this._configurationService.getConfigObservable(ConfigKey.Shared.Enable);
		this._ignoreCompletionsDisablement = this._configurationService.getConfigObservable(ConfigKey.Internal.InlineEditsIgnoreCompletionsDisablement);
	}

	public async isTrackingEnabled(document: TextDocument | NotebookDocument): Promise<boolean> {
		// this should filter out documents coming from output pane, git fs, etc.
		if (!['file', 'untitled'].includes(document.uri.scheme) && !isNotebookCellOrNotebookChatInput(document.uri)) {
			return false;
		}
		if (isTextDocument(document) && !this._isGhostTextEnabled(document.languageId)) {
			return false;
		}
		if (await this._ignoreService.isCopilotIgnored(document.uri)) {
			return false;
		}
		return true;
	}

	private _isGhostTextEnabled(languageId: string): boolean {
		const enabledLanguages = this._enabledLanguages.get();
		return enabledLanguages.get(languageId) ?? (
			enabledLanguages.get('*')! ||
			this._ignoreCompletionsDisablement.get() // respect if there's per-language setting but allow overriding global one
		);
	}

	private readonly _enabledLanguages = derived(this, (reader) => {
		const enabledLanguages = this._enabledLanguagesObs.read(reader);
		const enabledLanguagesMap = new Map(Object.entries(enabledLanguages));
		if (!enabledLanguagesMap.has('*')) {
			enabledLanguagesMap.set('*', false);
		}
		return enabledLanguagesMap;
	});
}

/**
 * Verifies that VS Code content change API reports consistent document edits.
 * Tracks document states and verifies that applying reported edits to the previous state
 * produces the new document state. Reports mismatches via telemetry.
 */
export class VerifyTextDocumentChanges extends Disposable {
	private readonly _documentStates = new Map<string, { text: string; linefeed: EndOfLine }>();

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		this._register(workspace.onDidOpenTextDocument(doc => {
			const docUri = doc.uri.toString();
			this._documentStates.set(docUri, { text: doc.getText(), linefeed: doc.eol });
		}));

		this._register(workspace.onDidCloseTextDocument(doc => {
			const docUri = doc.uri.toString();
			this._documentStates.delete(docUri);
		}));

		workspace.textDocuments.forEach(doc => {
			const docUri = doc.uri.toString();
			this._documentStates.set(docUri, { text: doc.getText(), linefeed: doc.eol });
		});

		this._register(workspace.onDidChangeTextDocument(e => {
			this._verifyDocumentStateConsistency(e);
		}));
	}

	private _verifyDocumentStateConsistency(e: TextDocumentChangeEvent): void {
		const docUri = e.document.uri.toString();
		const currentText = e.document.getText();
		const previousValue = this._documentStates.get(docUri);

		if (previousValue === undefined) {
			/* __GDPR__
				"vscode.contentChangeForUnknownDocument" : {
					"owner": "hediet",
					"comment": "Telemetry for verifying VSCode content change API consistency"
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('vscode.contentChangeForUnknownDocument', {}, {});
			return;
		}

		this._documentStates.set(docUri, { text: currentText, linefeed: e.document.eol });

		const edit = editFromTextDocumentContentChangeEvents(e.contentChanges);
		const expectedText = edit.apply(previousValue.text);

		if (expectedText !== currentText) {
			/* __GDPR__
				"vscode.contentChangeInconsistencyDetected" : {
					"owner": "hediet",
					"comment": "Telemetry for verifying VSCode content change API consistency",
					"languageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Language of the currently open document." },
					"sourceOfChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Source of the change." },
					"isLineFeedChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the change was a line feed change.", "isMeasurement": true },
					"reason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reason for change (1 = undo, 2 = redo).", "isMeasurement": true },
					"previousLineFeed": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Line feed of the previously open document.", "isMeasurement": true },
					"currentLineFeed": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Line feed of the currently open document.", "isMeasurement": true },
					"scheme": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Scheme of the currently open document." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('vscode.contentChangeInconsistencyDetected', {
				languageId: e.document.languageId,
				scheme: e.document.uri.scheme,
				sourceOfChange: e.detailedReason?.source || '',
			}, {
				reason: e.reason,
				previousLineFeed: previousValue.linefeed,
				currentLineFeed: e.document.eol,
				isLineFeedChange: expectedText.replace(/\r?\n/g, '') === currentText.replace(/\r?\n/g, '') ? 1 : 0
			});
		}
	}
}

export function stringValueFromDoc(doc: TextDocument): StringText {
	return new StringText(doc.getText());
}
export function editFromTextDocumentContentChangeEvents(events: readonly TextDocumentContentChangeEvent[]): StringEdit {
	const replacementsInApplicationOrder = events.map(e => StringReplacement.replace(OffsetRange.ofStartAndLength(e.rangeOffset, e.rangeLength), e.text));
	return StringEdit.composeSequentialReplacements(replacementsInApplicationOrder);
}

