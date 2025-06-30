/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { IObservableDocument, ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IReader, mapObservableArrayCached, observableSignal, runOnChange } from '../../../util/vs/base/common/observableInternal';
import { AnnotatedStringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CombineStreamedChanges, DocumentWithAnnotatedEdits, EditSource, EditSourceData, IDocumentWithAnnotatedEdits, MinimizeEditsProcessor } from './documentWithAnnotatedEdits';

/**
 * Tracks multiple documents.
*/
export class EditSourceTracker extends Disposable {
	private readonly docs;

	constructor(
		private readonly _workspace: ObservableWorkspace,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this.docs = mapObservableArrayCached(this, this._workspace.openDocuments, (doc, store) => {
			let processedDoc: IDocumentWithAnnotatedEdits = new DocumentWithAnnotatedEdits(doc);
			processedDoc = store.add(this._instantiationService.createInstance(CombineStreamedChanges, processedDoc));
			// Remove common suffix and prefix from edits
			processedDoc = store.add(new MinimizeEditsProcessor(processedDoc));

			return store.add(new DocumentEditSourceTracker<IObservableDocument>(processedDoc, doc));
		}).recomputeInitiallyAndOnChange(this._store);

		this._workspace.lastActiveDocument.recomputeInitiallyAndOnChange(this._store);
	}

	public async getTrackedRanges(docId: DocumentId): Promise<TrackedEdit[]> {
		const doc = this._getDocument(docId);
		if (!doc) {
			return [];
		}
		await doc.waitForQueue();
		return doc.getTrackedRanges();
	}

	public async reset(docId: DocumentId): Promise<void> {
		const doc = this._getDocument(docId);
		if (!doc) {
			return;
		}
		await doc.reset();
	}

	public async _getDebugVisualization(docId: DocumentId) {
		const t = this._getDocument(docId);
		if (!t) {
			return {
				...{ $fileExtension: 'text.w' },
				"value": 'no value',
			};
		}
		await t.waitForQueue();
		return t._getDebugVisualization();
	}

	/**
	 * Returns the document tracker for the given document ID.
	 * If the document is not found, it returns undefined.
	 */
	private _getDocument(docId: DocumentId): DocumentEditSourceTracker<IObservableDocument> | undefined {
		return this.docs.get().find(d => d.data.id === docId);
	}
}

/**
 * Tracks a single document.
*/
export class DocumentEditSourceTracker<T = void> extends Disposable {
	private _edits: AnnotatedStringEdit<EditSourceData> = AnnotatedStringEdit.empty;
	private _pendingExternalEdits: AnnotatedStringEdit<EditSourceData> = AnnotatedStringEdit.empty;

	private readonly _update = observableSignal(this);

	constructor(
		private readonly _doc: IDocumentWithAnnotatedEdits,
		public readonly data: T,
	) {
		super();

		this._register(runOnChange(this._doc.value, (_val, _prevVal, edits) => {
			const eComposed = AnnotatedStringEdit.compose(edits.map(e => e.edit));
			if (eComposed.replacements.every(e => e.data.source.category === 'external')) {
				if (this._edits.isEmpty()) {
					// Ignore initial external edits
				} else {
					// queue pending external edits
					this._pendingExternalEdits = this._pendingExternalEdits.compose(eComposed);
				}
			} else {
				if (!this._pendingExternalEdits.isEmpty()) {
					this._edits = this._edits.compose(this._pendingExternalEdits);
					this._pendingExternalEdits = AnnotatedStringEdit.empty;
				}
				this._edits = this._edits.compose(eComposed);
			}

			this._update.trigger(undefined);
		}));
	}

	async waitForQueue(): Promise<void> {
		await this._doc.waitForQueue();
	}

	getTrackedRanges(reader?: IReader): TrackedEdit[] {
		this._update.read(reader);
		const ranges = this._edits.getNewRanges();
		return ranges.map((r, idx) => {
			const e = this._edits.replacements[idx];
			const reason = e.data.source;
			const te = new TrackedEdit(e.replaceRange, r, reason, e.data.key);
			return te;
		});
	}

	isEmpty(): boolean {
		return this._edits.isEmpty();
	}

	public reset(): void {
		this._edits = AnnotatedStringEdit.empty;
	}

	public _getDebugVisualization() {
		const ranges = this.getTrackedRanges();
		const txt = this._doc.value.get().value;

		return {
			...{ $fileExtension: 'text.w' },
			"value": txt,
			"decorations": ranges.map(r => {
				return {
					range: [r.range.start, r.range.endExclusive],
					color: r.source.getColor(),
				};
			})
		};
	}
}

export class TrackedEdit {
	constructor(
		public readonly originalRange: OffsetRange,
		public readonly range: OffsetRange,
		public readonly source: EditSource,
		public readonly sourceKey: string,
	) { }
}
