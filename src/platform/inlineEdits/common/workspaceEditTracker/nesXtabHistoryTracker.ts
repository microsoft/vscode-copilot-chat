/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../../util/vs/base/common/assert';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { LinkedList } from '../../../../util/vs/base/common/linkedList';
import { mapObservableArrayCached } from '../../../../util/vs/base/common/observable';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { DocumentId } from '../dataTypes/documentId';
import { RootedEdit } from '../dataTypes/edit';
import { IObservableDocument, ObservableWorkspace } from '../observableWorkspace';
import { autorunWithChanges } from '../utils/observable';

export interface IXtabHistoryDocumentEntry {
	docId: DocumentId;
}

export interface IXtabHistoryEditEntry extends IXtabHistoryDocumentEntry {
	kind: 'edit';
	edit: RootedEdit;
}

export interface IXtabHistoryVisibleRangesEntry extends IXtabHistoryDocumentEntry {
	kind: 'visibleRanges';
	visibleRanges: readonly OffsetRange[];
	documentContent: StringText;
}

export type IXtabHistoryEntry =
	| IXtabHistoryEditEntry
	| IXtabHistoryVisibleRangesEntry

type DocumentChangedEvent = {
	value: StringText;
	changes: StringEdit[];
	previous: StringText | undefined;
}

type DocumentSelectionChangedEvent = {
	value: readonly OffsetRange[];
	changes: unknown[];
	previous: readonly OffsetRange[] | undefined;
}

export class NesXtabHistoryTracker extends Disposable {

	/** Max # of entries in history */
	private static MAX_HISTORY_SIZE = 50;

	private readonly idToEntry: Map<DocumentId, { entry: IXtabHistoryEntry; removeFromHistory: () => void }>;
	private readonly history: LinkedList<IXtabHistoryEntry>;

	constructor(workspace: ObservableWorkspace, private readonly maxHistorySize = NesXtabHistoryTracker.MAX_HISTORY_SIZE) {
		super();

		this.idToEntry = new Map();
		this.history = new LinkedList();

		mapObservableArrayCached(this, workspace.openDocuments, (doc, store) => {

			// add .value to all observables
			store.add(autorunWithChanges(this, {
				rootedEdits: doc.value,
				visibleRanges: doc.visibleRanges,
			}, (data) => {

				if (data.rootedEdits.changes.length > 0 && data.rootedEdits.previous !== undefined) {
					this.handleEdits(doc, data.rootedEdits);
				} else {
					this.handleVisibleRangesChange(doc, data.visibleRanges);
				}
			}));

		}, d => d.id).recomputeInitiallyAndOnChange(this._store);
	}

	getHistory(): IXtabHistoryEntry[] {
		return [...this.history];
	}

	/**
	 * If the document isn't already in history, add it to the history.
	 * If the document is in history either with an edit or selection entry, do not include it again.
	 */
	private handleVisibleRangesChange(doc: IObservableDocument, visibleRangesChange: DocumentSelectionChangedEvent) {
		if (visibleRangesChange.value.length === 0) {
			return;
		}

		const previousRecord = this.idToEntry.get(doc.id);

		// if this's an already known file
		if (previousRecord !== undefined) {
			// if it's an edit entry, do not change anything
			if (previousRecord.entry.kind === 'edit') {
				return;
			}
			// else remove from history to update the visible ranges
			previousRecord.removeFromHistory();
		}

		const entry: IXtabHistoryEntry = { docId: doc.id, kind: 'visibleRanges', visibleRanges: visibleRangesChange.value, documentContent: doc.value.get() };
		const removeFromHistory = this.history.push(entry);
		this.idToEntry.set(doc.id, { entry, removeFromHistory });

		this.compactHistory();
	}

	private handleEdits(doc: IObservableDocument, rootedEdits: DocumentChangedEvent) {
		assert(rootedEdits.previous !== undefined, `Document has previous version`);
		assert(rootedEdits.changes.length === 1, `Expected 1 edit change but got ${rootedEdits.changes.length}`);

		const currentEdit = rootedEdits.changes[0];
		if (currentEdit.replacements.length === 0) {
			return;
		}

		const previousRecord = this.idToEntry.get(doc.id);

		// const currentBase = rootedEdits.value.apply(currentEdit.inverseOnString(rootedEdits.previous.value));
		const currentBase = rootedEdits.previous;
		const currentRootedEdit = new RootedEdit(currentBase, currentEdit);

		if (previousRecord === undefined) {
			this.pushToHistory(doc.id, currentRootedEdit);
			return;
		}

		if (previousRecord.entry.kind === 'visibleRanges') {
			previousRecord.removeFromHistory();
			this.pushToHistory(doc.id, currentRootedEdit);
			return;
		}

		const lastRootedEdit = previousRecord.entry.edit;

		const lastLineEdit = RootedEdit.toLineEdit(lastRootedEdit);

		const currentLineEdit = RootedEdit.toLineEdit(currentRootedEdit);

		if (!currentLineEdit.isEmpty() && !lastLineEdit.isEmpty() && lastLineEdit.replacements[0].lineRange.startLineNumber === currentLineEdit.replacements[0].lineRange.startLineNumber) {
			// merge edits
			previousRecord.removeFromHistory();
			const composedEdit = lastRootedEdit.edit.compose(currentEdit);
			const edit = new RootedEdit(lastRootedEdit.base, composedEdit);
			this.pushToHistory(doc.id, edit);

		} else {
			this.pushToHistory(doc.id, currentRootedEdit);
		}
	}

	private pushToHistory(docId: DocumentId, edit: RootedEdit) {
		const entry: IXtabHistoryEntry = { docId, kind: 'edit', edit };
		const removeFromHistory = this.history.push(entry);
		this.idToEntry.set(docId, { entry, removeFromHistory });

		this.compactHistory();
	}

	private compactHistory() {
		if (this.history.size > this.maxHistorySize) {
			const removedEntry = this.history.shift();
			if (removedEntry !== undefined) {
				const lastRecord = this.idToEntry.get(removedEntry.docId);
				if (lastRecord !== undefined && removedEntry === lastRecord.entry) {
					this.idToEntry.delete(removedEntry.docId);
				}
			}
		}
	}
}
