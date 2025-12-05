/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { serializeStringEdit } from '../../../platform/inlineEdits/common/dataTypes/editUtils';
import { LanguageId } from '../../../platform/inlineEdits/common/dataTypes/languageId';
import { DebugRecorderBookmark } from '../../../platform/inlineEdits/common/debugRecorderBookmark';
import { ObservableGit } from '../../../platform/inlineEdits/common/observableGit';
import { ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { autorunWithChanges } from '../../../platform/inlineEdits/common/utils/observable';
import { Instant, now } from '../../../platform/inlineEdits/common/utils/utils';
import { ISerializedOffsetRange, LogEntry } from '../../../platform/workspaceRecorder/common/workspaceLog';
import { compareBy, numberComparator } from '../../../util/vs/base/common/arrays';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../util/vs/base/common/network';
import { autorun, mapObservableArrayCached } from '../../../util/vs/base/common/observableInternal';
import { relative } from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { StringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';

export class DebugRecorder extends Disposable {
	private static readonly MAX_TRACKED_DOCUMENTS = 50;

	private _id: number = 0;
	private readonly _documentHistories = new Map<DocumentId, DocumentHistory>();
	private readonly _documentAccessOrder = new FifoSet<DocumentId>(DebugRecorder.MAX_TRACKED_DOCUMENTS);
	private readonly _activeBookmarks = new Set<DebugRecorderBookmark>();

	private _workspaceRoot: URI | undefined;
	private _lastGitCheckout: Instant | undefined;
	private _cleanupInterval: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly _workspace: ObservableWorkspace,
		private readonly _observableGit: ObservableGit | undefined = undefined,
		private readonly getNow = now
	) {
		super();

		// Watch for git branch changes
		if (this._observableGit) {
			this._register(autorun(reader => {
				const branch = reader.readObservable(this._observableGit!.branch);
				if (branch === undefined) {
					return;
				}
				this._lastGitCheckout = this.getNow();
				// Collapse all edits on git checkout
				this._documentHistories.forEach(d => d.applyAllEdits());
			}));
		}

		// Periodic cleanup every 30 seconds
		this._cleanupInterval = setInterval(() => {
			this._cleanupOldBookmarks();
			const oldestBookmarkTime = this._getOldestActiveBookmarkTime();
			this._documentHistories.forEach(d => d.cleanUpHistory(oldestBookmarkTime));
		}, 30000);

		mapObservableArrayCached(this, this._workspace.openDocuments, (doc, store) => {
			const root = this._workspace.getWorkspaceRoot(doc.id);
			if (!root) {
				return;
			}
			if (!this._workspaceRoot) {
				this._workspaceRoot = root;
			} else {
				if (this._workspaceRoot.toString() !== root.toString()) {
					// document is from a different root -> ignore
					return;
				}
			}

			const state = new DocumentHistory(root, doc.id, doc.value.get().value, this._id++, doc.languageId.get(), () => this.getTimestamp());
			this._documentHistories.set(state.docId, state);

			store.add(autorunWithChanges(this, {
				value: doc.value,
				selection: doc.selection,
				languageId: doc.languageId,
			}, (data) => {
				if (data.languageId.changes.length > 0) {
					state.languageId = data.languageId.value;
				}
				const isInCooldown = this._isAwaitingGitCheckoutCooldown();
				for (const edit of data.value.changes) {
					state.handleEdit(edit, isInCooldown);
					// Track document access on edit
					this._documentAccessOrder.push(doc.id);
					this._evictOldestDocumentIfNeeded();
				}
				if (data.selection.changes.length > 0) {
					state.handleSelection(data.selection.value.at(0));
					// Track document access on selection
					this._documentAccessOrder.push(doc.id);
				}
			}));

			store.add(toDisposable(() => {
				this._documentHistories.delete(doc.id);
				this._documentAccessOrder.remove(doc.id);
			}));
		}, d => d.id).recomputeInitiallyAndOnChange(this._store);
	}

	override dispose(): void {
		if (this._cleanupInterval) {
			clearInterval(this._cleanupInterval);
			this._cleanupInterval = undefined;
		}
		super.dispose();
	}

	private _isAwaitingGitCheckoutCooldown(): boolean {
		if (!this._lastGitCheckout) {
			return false;
		}
		const isInCooldown = this.getNow() - this._lastGitCheckout < 2 * 1000;
		if (!isInCooldown) {
			this._lastGitCheckout = undefined;
		}
		return isInCooldown;
	}

	private _evictOldestDocumentIfNeeded(): void {
		if (this._documentHistories.size > DebugRecorder.MAX_TRACKED_DOCUMENTS) {
			const oldestDocId = this._documentAccessOrder.getOldest();
			if (oldestDocId) {
				this._documentHistories.delete(oldestDocId);
				this._documentAccessOrder.removeOldest();
			}
		}
	}

	private _cleanupOldBookmarks(): void {
		const fiveMinutesAgo = this.getNow() - 5 * 60 * 1000;
		for (const bookmark of this._activeBookmarks) {
			if (bookmark.timeMs < fiveMinutesAgo) {
				this._activeBookmarks.delete(bookmark);
			}
		}
	}

	private _getOldestActiveBookmarkTime(): number {
		let oldest = this.getNow();
		for (const bookmark of this._activeBookmarks) {
			oldest = Math.min(oldest, bookmark.timeMs);
		}
		return oldest;
	}

	private _lastTimestamp: number | undefined;
	public getTimestamp(): number {
		let newTimestamp = this.getNow();
		if (this._lastTimestamp !== undefined && newTimestamp <= this._lastTimestamp) { // we want total ordering on the events
			newTimestamp = this._lastTimestamp + 1;
		}
		this._lastTimestamp = newTimestamp;
		return newTimestamp;
	}

	public getRecentLog(bookmark: DebugRecorderBookmark | undefined = undefined): LogEntry[] | undefined {
		if (!this._workspaceRoot) { // possible if the open file doesn't belong to a workspace
			return undefined;
		}

		const log: {
			entry: LogEntry;
			sortTime: number;
		}[] = [];

		log.push({ entry: { documentType: 'workspaceRecording@1.0', kind: 'header', repoRootUri: this._workspaceRoot.toString(), time: this.getNow(), uuid: generateUuid() }, sortTime: 0 });

		const oldestBookmarkTime = this._getOldestActiveBookmarkTime();
		for (const doc of this._documentHistories.values()) {
			log.push(...doc.getDocumentLog(bookmark, oldestBookmarkTime));
		}

		log.sort(compareBy(e => e.sortTime, numberComparator));

		return log.map(l => l.entry);
	}

	public createBookmark(): DebugRecorderBookmark {
		const bookmark = new DebugRecorderBookmark(this.getNow());
		this._activeBookmarks.add(bookmark);
		return bookmark;
	}

	public getMemoryStats(): { documentCount: number; totalEdits: number; avgEditsPerDoc: number; totalBaseValueSize: number } {
		let totalEdits = 0;
		let totalBaseValueSize = 0;
		for (const doc of this._documentHistories.values()) {
			const stats = doc.getStats();
			totalEdits += stats.editCount;
			totalBaseValueSize += stats.baseValueSize;
		}
		return {
			documentCount: this._documentHistories.size,
			totalEdits,
			avgEditsPerDoc: this._documentHistories.size > 0 ? totalEdits / this._documentHistories.size : 0,
			totalBaseValueSize
		};
	}
}

class DocumentHistory {
	private static readonly MAX_EDITED_LINES_PER_EDIT = 10;
	private static readonly MAX_EDITED_CHARS_PER_EDIT = 5000;
	private static readonly MAX_LINE_EDITS_TO_RETAIN = 10;
	private static readonly STALE_EDIT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
	private static readonly MAX_BASE_VALUE_SIZE = 1024 * 1024; // 1MB

	private _baseValue: StringText;
	private _currentValue: StringText;
	/**
	 * Stores only edits (no selections) in the order they happened.
	 */
	private _edits: {
		kind: 'edit';
		edit: StringEdit;
		instant: Instant;
	}[] = [];

	private _lastSelection: OffsetRange | undefined;
	private _stopTracking: boolean = false;

	public readonly creationTime: number;

	constructor(
		public readonly workspaceUri: URI,
		public readonly docId: DocumentId,
		initialValue: string,
		public readonly id: number,
		public languageId: LanguageId,
		private readonly getNow: () => Instant
	) {
		this._baseValue = new StringText(initialValue);
		this._currentValue = this._baseValue;
		this.creationTime = this.getNow();
	}

	public handleSelection(selection: OffsetRange | undefined): void {
		this._lastSelection = selection;
	}

	public handleEdit(edit: StringEdit, isInCooldown: boolean): void {
		if (edit.isEmpty() || this._stopTracking) {
			return;
		}

		// Update current value
		this._currentValue = edit.applyOnText(this._currentValue);

		// Check if base value is too large
		if (this._baseValue.value.length > DocumentHistory.MAX_BASE_VALUE_SIZE) {
			this._stopTracking = true;
			return;
		}

		// If in git cooldown, collapse immediately
		if (isInCooldown) {
			this._baseValue = this._currentValue;
			this._edits = [];
			return;
		}

		// Calculate edit size
		const editLineCount = edit.replacements.length;  // Number of replacement operations
		let editCharCount = 0;
		for (const replacement of edit.replacements) {
			editCharCount += replacement.newText.length;
		}

		// If edit is too large, collapse immediately
		if (editLineCount > DocumentHistory.MAX_EDITED_LINES_PER_EDIT ||
			editCharCount > DocumentHistory.MAX_EDITED_CHARS_PER_EDIT) {
			this._baseValue = this._currentValue;
			this._edits = [];
			return;
		}

		// Try to merge with last edit if it's small and consecutive
		const lastEdit = this._edits.at(-1);
		if (lastEdit && editInsertSize(lastEdit.edit) < 200 && editTouches(edit, lastEdit.edit)) {
			// Merge edits using compose
			lastEdit.edit = lastEdit.edit.compose(edit);
			lastEdit.instant = this.getNow();
			// If the composed edit is empty (e.g., undo), remove it
			if (lastEdit.edit.isEmpty()) {
				this._edits.pop();
			}
		} else {
			this._edits.push({ kind: 'edit', edit, instant: this.getNow() });
		}
	}

	public applyAllEdits(): void {
		this._baseValue = this._currentValue;
		this._edits = [];
	}

	public cleanUpHistory(oldestBookmarkTime: number): void {
		if (this._edits.length === 0) {
			return;
		}

		const now = this.getNow();
		const staleTime = now - DocumentHistory.STALE_EDIT_THRESHOLD_MS;
		const bookmarkBufferTime = oldestBookmarkTime - 30000; // 30 second buffer
		const earliestTime = Math.min(staleTime, bookmarkBufferTime);

		// Calculate line edits from the end
		let lineEditCount = 0;
		let keepFromIndex = 0;  // Start from 0, will be updated if we need to drop old edits

		for (let i = this._edits.length - 1; i >= 0; i--) {
			const edit = this._edits[i];

			// Always keep edits within time threshold
			if (edit.instant >= earliestTime) {
				continue;
			}

			// Calculate how many line edits this would add
			const editLines = edit.edit.replacements.length;

			if (lineEditCount + editLines > DocumentHistory.MAX_LINE_EDITS_TO_RETAIN) {
				// Too many line edits, stop here
				keepFromIndex = i + 1;
				break;
			}

			lineEditCount += editLines;
		}

		// Collapse edits older than keepFromIndex into base value
		for (let i = 0; i < keepFromIndex; i++) {
			const edit = this._edits[i];
			this._baseValue = edit.edit.applyOnText(this._baseValue);
		}

		this._edits = this._edits.slice(keepFromIndex);
	}

	public getStats(): { editCount: number; baseValueSize: number } {
		return {
			editCount: this._edits.length,
			baseValueSize: this._baseValue.value.length
		};
	}

	private readonly relativePath = (() => {
		const basePath = relative(this.workspaceUri.path, this.docId.path);
		return this.docId.toUri().scheme === Schemas.vscodeNotebookCell ? `${basePath}#${this.docId.fragment}` : basePath;
	})();

	getDocumentLog(bookmark: DebugRecorderBookmark | undefined, oldestBookmarkTime: number): { entry: LogEntry; sortTime: number }[] {
		this.cleanUpHistory(oldestBookmarkTime);

		// If bookmark is specified and document was created after it, don't include it
		if (bookmark && this.creationTime > bookmark.timeMs) {
			return [];
		}

		// Always output document setup, even for documents without edits
		// This matches the old behavior and ensures all opened documents are logged
		const log: { entry: LogEntry; sortTime: number }[] = [];
		log.push({ entry: { kind: 'documentEncountered', id: this.id, relativePath: this.relativePath, time: this.creationTime }, sortTime: this.creationTime });
		let docVersion = 1;
		log.push({ entry: { kind: 'setContent', id: this.id, v: docVersion, content: this._baseValue.value, time: this.creationTime }, sortTime: this.creationTime });
		log.push({ entry: { kind: 'opened', id: this.id, time: this.creationTime }, sortTime: this.creationTime });

		// Add last selection if available
		if (this._lastSelection) {
			const serializedOffsetRange: ISerializedOffsetRange[] = [[this._lastSelection.start, this._lastSelection.endExclusive]];
			log.push({ entry: { kind: 'selectionChanged', id: this.id, selection: serializedOffsetRange, time: this.creationTime }, sortTime: this.creationTime });
		}

		for (const edit of this._edits) {
			if (bookmark && edit.instant > bookmark.timeMs) {
				// only considers edits that happened before the bookmark
				break;
			}
			docVersion++;
			log.push({ entry: { kind: 'changed', id: this.id, v: docVersion, edit: serializeStringEdit(edit.edit), time: edit.instant }, sortTime: edit.instant });
		}

		return log;
	}
}

/**
 * A FIFO (First-In-First-Out) set with a maximum size.
 * When the maximum size is reached, the oldest element is removed.
 * Elements are moved to the end when re-added.
 */
class FifoSet<T> {
	private _items: T[] = [];

	constructor(private readonly maxSize: number) { }

	push(item: T): void {
		const existingIndex = this._items.indexOf(item);
		if (existingIndex !== -1) {
			this._items.splice(existingIndex, 1);
		} else if (this._items.length >= this.maxSize) {
			this._items.shift();
		}
		this._items.push(item);
	}

	remove(item: T): void {
		const existingIndex = this._items.indexOf(item);
		if (existingIndex !== -1) {
			this._items.splice(existingIndex, 1);
		}
	}

	getItemsReversed(): readonly T[] {
		return this._items.slice().reverse();
	}

	has(item: T): boolean {
		return this._items.indexOf(item) !== -1;
	}

	getOldest(): T | undefined {
		return this._items[0];
	}

	removeOldest(): void {
		this._items.shift();
	}

	get size(): number {
		return this._items.length;
	}
}

/**
 * Checks if an edit touches the boundary of a previous edit.
 * Used to determine if consecutive edits can be merged.
 *
 * For edits to be mergeable via compose, the new edit must touch the result of the previous edit.
 * This means checking if the new edit's original ranges touch the "new" ranges of the previous edit
 * (the ranges in the text after the previous edit was applied).
 */
function editTouches(edit: StringEdit, previousEdit: StringEdit): boolean {
	// Get the ranges in the result of the previous edit
	const newRanges = previousEdit.getNewRanges();

	// For each replacement in the new edit, check if it touches any of the new ranges
	// from the previous edit. We need ALL replacements to touch for a clean merge.
	return edit.replacements.every(replacement => {
		return newRanges.some(newRange =>
			// The replacement touches if it starts where a newRange ends or ends where a newRange starts
			replacement.replaceRange.start === newRange.endExclusive ||
			replacement.replaceRange.endExclusive === newRange.start
		);
	});
}

/**
 * Calculates the total size of inserted text in an edit.
 */
function editInsertSize(edit: StringEdit): number {
	let size = 0;
	for (const replacement of edit.replacements) {
		size += replacement.newText.length;
	}
	return size;
}
