/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { IObservableDocument, ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { autorunWithChanges } from '../../../platform/inlineEdits/common/utils/observable';
import { ILogService } from '../../../platform/log/common/logService';
import { LRUCache } from '../../../util/common/cache';
import { createTracer, ITracer } from '../../../util/common/tracing';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { mapObservableArrayCached } from '../../../util/vs/base/common/observableInternal';
import { AnnotatedStringReplacement, StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { checkEditConsistency, EditDataWithIndex, tryRebase } from '../common/editRebase';
import { INesConfigs } from './nesConfigs';
import { NextEditFetchRequest } from './nextEditProvider';

export interface CachedEdit {
	docId: DocumentId;
	documentBeforeEdit: StringText;
	editWindow?: OffsetRange;
	edit?: StringReplacement;
	edits?: StringReplacement[];
	detailedEdits: AnnotatedStringReplacement<EditDataWithIndex>[][];
	userEditSince?: StringEdit;
	rebaseFailed?: boolean;
	rejected?: boolean;

	/**
	 * When caching multiple edits, this is the order in which they were applied.
	 */
	subsequentN?: number;
	source: NextEditFetchRequest;
	cacheTime: number;
}

export type CachedOrRebasedEdit = CachedEdit & { rebasedEdit?: StringReplacement; rebasedEditIndex?: number };

export class NextEditCache extends Disposable {
	private readonly _documentCaches = new Map<DocumentId, DocumentEditCache>();
	private readonly _sharedCache = new LRUCache<CachedEdit>(50);

	constructor(
		public readonly workspace: ObservableWorkspace,
		private readonly _logService: ILogService,
	) {
		super();

		mapObservableArrayCached(this, workspace.openDocuments, (doc, store) => {
			const state = new DocumentEditCache(this, doc.id, doc, this._sharedCache, this._logService);
			this._documentCaches.set(state.docId, state);

			store.add(autorunWithChanges(this, {
				value: doc.value,
			}, (data) => {
				for (const edit of data.value.changes) {
					if (!edit.isEmpty()) {
						state.handleEdit(edit);
					}
				}
			}));

			store.add(toDisposable(() => {
				this._documentCaches.delete(doc.id);
			}));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	public setKthNextEdit(docId: DocumentId, documentContents: StringText, editWindow: OffsetRange | undefined, nextEdit: StringReplacement, subsequentN: number, nextEdits: StringReplacement[] | undefined, userEditSince: StringEdit | undefined, source: NextEditFetchRequest): CachedEdit | undefined {
		const docCache = this._documentCaches.get(docId);
		if (!docCache) {
			return;
		}
		return docCache.setKthNextEdit(documentContents, editWindow, nextEdit, nextEdits, userEditSince, subsequentN, source);
	}

	public setNoNextEdit(docId: DocumentId, documentContents: StringText, editWindow: OffsetRange | undefined, source: NextEditFetchRequest, nesConfigs: INesConfigs) {
		const docCache = this._documentCaches.get(docId);
		if (!docCache) {
			return;
		}
		docCache.setNoNextEdit(documentContents, editWindow, source, nesConfigs);
	}

	public lookupNextEdit(docId: DocumentId, currentDocumentContents: StringText, currentSelection: readonly OffsetRange[], nesConfigs: INesConfigs): CachedOrRebasedEdit | undefined {
		const docCache = this._documentCaches.get(docId);
		if (!docCache) {
			return undefined;
		}
		return docCache.lookupNextEdit(currentDocumentContents, currentSelection, nesConfigs);
	}

	public tryRebaseCacheEntry(cachedEdit: CachedEdit, currentDocumentContents: StringText, currentSelection: readonly OffsetRange[], nesConfigs: INesConfigs): CachedOrRebasedEdit | undefined {
		const docCache = this._documentCaches.get(cachedEdit.docId);
		if (!docCache) {
			return undefined;
		}
		return docCache.tryRebaseCacheEntry(cachedEdit, currentDocumentContents, currentSelection, nesConfigs);
	}

	public rejectedNextEdit(requestId: string): void {
		this._sharedCache.getValues()
			.filter(v => v.source.headerRequestId === requestId)
			.forEach(v => v.rejected = true);
	}

	public isRejectedNextEdit(docId: DocumentId, currentDocumentContents: StringText, edit: StringReplacement, nesConfigs: INesConfigs) {
		const docCache = this._documentCaches.get(docId);
		if (!docCache) {
			return false;
		}
		return docCache.isRejectedNextEdit(currentDocumentContents, edit, nesConfigs);
	}

	public evictedCachedEdit(cachedEdit: CachedEdit) {
		const docCache = this._documentCaches.get(cachedEdit.docId);
		if (docCache) {
			docCache.evictedCachedEdit(cachedEdit);
		}
	}

	public clear() {
		this._documentCaches.forEach(cache => cache.clear());
		this._sharedCache.clear();
	}
}

class DocumentEditCache {

	private readonly _trackedCachedEdits: CachedEdit[] = [];
	private _tracer: ITracer;

	constructor(
		private readonly _nextEditCache: NextEditCache,
		public readonly docId: DocumentId,
		private readonly _doc: IObservableDocument,
		private readonly _sharedCache: LRUCache<CachedEdit>,
		private readonly _logService: ILogService,
	) {
		this._tracer = createTracer(['NES', 'DocumentEditCache'], (s) => this._logService.trace(s));
	}

	public handleEdit(edit: StringEdit): void {
		const tracer = this._tracer.sub('handleEdit');
		for (const cachedEdit of this._trackedCachedEdits) {
			if (cachedEdit.userEditSince) {
				cachedEdit.userEditSince = cachedEdit.userEditSince.compose(edit);
				cachedEdit.rebaseFailed = false;
				if (!checkEditConsistency(cachedEdit.documentBeforeEdit.value, cachedEdit.userEditSince, this._doc.value.get().value, tracer)) {
					cachedEdit.userEditSince = undefined;
				}
			}
		}
	}

	public evictedCachedEdit(cachedEdit: CachedEdit) {
		const index = this._trackedCachedEdits.indexOf(cachedEdit);
		if (index !== -1) {
			this._trackedCachedEdits.splice(index, 1);
		}
	}

	public clear() {
		this._trackedCachedEdits.length = 0;
	}

	public setKthNextEdit(documentContents: StringText, editWindow: OffsetRange | undefined, nextEdit: StringReplacement, nextEdits: StringReplacement[] | undefined, userEditSince: StringEdit | undefined, subsequentN: number, source: NextEditFetchRequest): CachedEdit {
		const key = this._getKey(documentContents.value);
		const cachedEdit: CachedEdit = { docId: this.docId, edit: nextEdit, edits: nextEdits, detailedEdits: [], userEditSince, subsequentN, source, documentBeforeEdit: documentContents, editWindow, cacheTime: Date.now() };
		if (userEditSince) {
			if (!checkEditConsistency(cachedEdit.documentBeforeEdit.value, userEditSince, this._doc.value.get().value, this._tracer.sub('setKthNextEdit'))) {
				cachedEdit.userEditSince = undefined;
			} else {
				this._trackedCachedEdits.unshift(cachedEdit);
			}
		}
		const existing = this._sharedCache.get(key);
		if (existing) {
			this.evictedCachedEdit(existing);
		}
		const evicted = this._sharedCache.put(key, cachedEdit);
		if (evicted) {
			this._nextEditCache.evictedCachedEdit(evicted[1]);
		}
		return cachedEdit;
	}

	public setNoNextEdit(documentContents: StringText, editWindow: OffsetRange | undefined, source: NextEditFetchRequest, nesConfigs: INesConfigs) {
		const key = this._getKey(documentContents.value);
		const cachedEdit: CachedEdit = { docId: this.docId, edits: [], detailedEdits: [], source, documentBeforeEdit: documentContents, editWindow, cacheTime: Date.now() };
		const existing = this._sharedCache.get(key);
		if (existing) {
			this.evictedCachedEdit(existing);
		}
		const evicted = this._sharedCache.put(key, cachedEdit);
		if (evicted) {
			this._nextEditCache.evictedCachedEdit(evicted[1]);
		}
	}

	public lookupNextEdit(currentDocumentContents: StringText, currentSelection: readonly OffsetRange[], nesConfigs: INesConfigs): CachedOrRebasedEdit | undefined {
		// TODO@chrmarti: Update entries i > 1 with user edits and edit window and start tracking.
		const key = this._getKey(currentDocumentContents.value);
		const cachedEdit = this._sharedCache.get(key);
		if (cachedEdit) {
			const editWindow = cachedEdit.editWindow;
			const cursorRange = currentSelection[0];
			if (editWindow && cursorRange && !editWindow.containsRange(cursorRange)) {
				return undefined;
			}
			return cachedEdit;
		}
		if (!nesConfigs.isRevisedCacheStrategy) {
			return undefined;
		}
		for (const cachedEdit of this._trackedCachedEdits) {
			const rebased = this.tryRebaseCacheEntry(cachedEdit, currentDocumentContents, currentSelection, nesConfigs);
			if (rebased) {
				return rebased;
			}
		}
		return undefined;
	}

	public tryRebaseCacheEntry(cachedEdit: CachedEdit, currentDocumentContents: StringText, currentSelection: readonly OffsetRange[], nesConfigs: INesConfigs) {
		const tracer = this._tracer.sub('tryRebaseCacheEntry');
		if (cachedEdit.userEditSince && !cachedEdit.rebaseFailed) {
			const originalEdits = cachedEdit.edits || (cachedEdit.edit ? [cachedEdit.edit] : []);
			const res = tryRebase(cachedEdit.documentBeforeEdit.value, cachedEdit.editWindow, originalEdits, cachedEdit.detailedEdits, cachedEdit.userEditSince, currentDocumentContents.value, currentSelection, 'strict', tracer, nesConfigs);
			if (res === 'rebaseFailed') {
				cachedEdit.rebaseFailed = true;
			} else if (res === 'inconsistentEdits' || res === 'error') {
				cachedEdit.userEditSince = undefined;
			} else if (res === 'outsideEditWindow') {
				// miss
			} else if (res.length) {
				if (!cachedEdit.rejected && this.isRejectedNextEdit(currentDocumentContents, res[0].rebasedEdit, nesConfigs)) {
					cachedEdit.rejected = true;
				}
				return { ...cachedEdit, ...res[0] };
			} else if (!originalEdits.length) {
				return cachedEdit; // cached 'no edits'
			}
		}
		return undefined;
	}

	public isRejectedNextEdit(currentDocumentContents: StringText, edit: StringReplacement, nesConfigs: INesConfigs) {
		const tracer = this._tracer.sub('isRejectedNextEdit');
		const resultEdit = edit.removeCommonSuffixAndPrefix(currentDocumentContents.value);
		for (const rejectedEdit of this._trackedCachedEdits.filter(edit => edit.rejected)) {
			if (!rejectedEdit.userEditSince) {
				continue;
			}
			const edits = rejectedEdit.edits || (rejectedEdit.edit ? [rejectedEdit.edit] : []);
			if (!edits.length) {
				continue; // cached 'no edits'
			}
			const rejectedEdits = tryRebase(rejectedEdit.documentBeforeEdit.value, undefined, edits, rejectedEdit.detailedEdits, rejectedEdit.userEditSince, currentDocumentContents.value, [], 'lenient', tracer, nesConfigs);
			if (typeof rejectedEdits === 'string') {
				continue;
			}
			const rejected = rejectedEdits.some(rejected => rejected.rebasedEdit.removeCommonSuffixAndPrefix(currentDocumentContents.value).equals(resultEdit));
			if (rejected) {
				tracer.trace('Found rejected edit that matches current edit');
				return true;
			}
		}
		return false;
	}

	private _getKey(val: string): string {
		return JSON.stringify([this.docId.uri, val]);
	}
}
