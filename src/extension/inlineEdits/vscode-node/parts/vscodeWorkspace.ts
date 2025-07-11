/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Diagnostic, DiagnosticSeverity, EndOfLine, languages, Range, TextDocument, TextDocumentChangeEvent, TextDocumentContentChangeEvent, Uri, window, workspace } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IIgnoreService } from '../../../../platform/ignore/common/ignoreService';
import { DiagnosticData } from '../../../../platform/inlineEdits/common/dataTypes/diagnosticData';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { EditReason } from '../../../../platform/inlineEdits/common/editReason';
import { IObservableDocument, ObservableWorkspace, StringEditWithReason } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { findNotebook, isNotebookCellOrNotebookChatInput } from '../../../../util/common/notebooks';
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

	constructor(
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IInstantiationService private readonly _instaService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
		super();

		this._filter = this._instaService.createInstance(DocumentFilter);

		const config = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.VerifyTextDocumentChanges, this._experimentationService);
		this._store.add(autorun(reader => {
			if (config.read(reader)) {
				reader.store.add(this._instaService.createInstance(VerifyTextDocumentChanges));
			}
		}));

		let lastDocs: Map<DocumentId, VSCodeObservableDocument> = new Map();
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
			const doc = this._getDocumentByTextDocumentAndUpdateShouldTrack(e.document.uri);
			if (!doc) {
				return;
			}
			const edit = editFromTextDocumentContentChangeEvents(e.contentChanges);
			const editWithReason = new StringEditWithReason(edit.replacements, EditReason.create(e.detailedReason?.metadata as any));
			transaction(tx => {
				doc.languageId.set(LanguageId.create(e.document.languageId), tx);
				doc.value.set(stringValueFromDoc(e.document), tx, editWithReason);
				doc.version.set(e.document.version, tx);
			});
		}));

		this._store.add(window.onDidChangeTextEditorSelection(e => {
			const doc = this._getDocumentByTextDocumentAndUpdateShouldTrack(e.textEditor.document.uri);
			if (!doc) {
				return;
			}
			doc.selection.set(e.selections.map(s => rangeToOffsetRange(s, e.textEditor.document)), undefined);
		}));

		this._store.add(window.onDidChangeTextEditorVisibleRanges(e => {
			const doc = this._getDocumentByTextDocumentAndUpdateShouldTrack(e.textEditor.document.uri);
			if (!doc) {
				return;
			}
			doc.visibleRanges.set(e.visibleRanges.map(r => rangeToOffsetRange(r, e.textEditor.document)), undefined);
		}));

		this._store.add(languages.onDidChangeDiagnostics(e => {
			e.uris.forEach(uri => {
				const document = this._getDocumentByTextDocumentAndUpdateShouldTrack(uri);
				if (!document) {
					return;
				}
				const diagnostics = languages.getDiagnostics(uri).map(d => this._createDiagnosticData(d, document.textDocument)).filter(isDefined);
				document.diagnostics.set(diagnostics, undefined);
			});
		}));
	}

	public dispose(): void {
		this._store.dispose();
	}

	private readonly _obsDocsByDocId = derived(this, reader => {
		const docs = this._docsWithShouldTrackFlag.read(reader);
		const obsDocs = docs.map(d => d.obsDoc.read(reader)).filter(isDefined);
		const map = new Map(obsDocs.map(d => [d.id, d]));
		return map;
	});

	private readonly _vscodeTextDocuments = getTextDocuments();
	private readonly _docsWithShouldTrackFlag = mapObservableArrayCached(this, this._vscodeTextDocuments, (doc, store) => {
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
			const diagnostics = languages.getDiagnostics(doc.uri).map(d => this._createDiagnosticData(d, doc)).filter(isDefined);
			const document = new VSCodeObservableDocument(documentId, stringValueFromDoc(doc), doc.version, selections ?? [], visibleRanges ?? [], LanguageId.create(doc.languageId), diagnostics, doc);
			return document;
		}).recomputeInitiallyAndOnChange(store);

		updateShouldTrack();
		return {
			doc,
			updateShouldTrack,
			obsDoc,
		};
	});

	private _getDocumentByTextDocumentAndUpdateShouldTrack(uri: URI): VSCodeObservableDocument | undefined {
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

	private readonly _obsDocsWithUpdateIgnored = derived(this, reader => {
		const docs = this._docsWithShouldTrackFlag.read(reader);
		return new Map(docs.map(d => [d.doc.uri.toString(), d]));
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

export interface IVSCodeObservableDocument extends IObservableDocument {
	readonly textDocument: TextDocument;
}

class VSCodeObservableDocument implements IVSCodeObservableDocument {
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
		diagnostics: DiagnosticData[],
		public readonly textDocument: TextDocument,
	) {
		this.value = observableValue(this, value);
		this.version = observableValue(this, versionId);
		this.selection = observableValue(this, selection);
		this.visibleRanges = observableValue(this, visibleRanges);
		this.languageId = observableValue(this, languageId);
		this.diagnostics = observableValue(this, diagnostics);
	}
}

function rangeToOffsetRange(range: Range, doc: TextDocument): OffsetRange {
	return new OffsetRange(doc.offsetAt(range.start), doc.offsetAt(range.end));
}

function getTextDocuments(): IObservable<readonly TextDocument[]> {
	return observableFromEvent(undefined, e => {
		const d1 = workspace.onDidOpenTextDocument(e);
		const d2 = workspace.onDidCloseTextDocument(e);
		return {
			dispose: () => {
				d1.dispose();
				d2.dispose();
			}
		};
	}, () => workspace.textDocuments);
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

	public async isTrackingEnabled(document: TextDocument): Promise<boolean> {
		// this should filter out documents coming from output pane, git fs, etc.
		if (!['file', 'untitled'].includes(document.uri.scheme) && !isNotebookCellOrNotebookChatInput(document.uri)) {
			return false;
		}
		if (!this._isGhostTextEnabled(document.languageId)) {
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

