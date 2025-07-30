/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../platform/inlineEdits/common/dataTypes/edit';
import { RootedLineEdit } from '../../../platform/inlineEdits/common/dataTypes/rootedLineEdit';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { IObservableDocument, ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditProvider, NoNextEditReason, PushEdit, ShowNextEditPreference, StatelessNextEditDocument, StatelessNextEditRequest, StatelessNextEditResult } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { autorunWithChanges } from '../../../platform/inlineEdits/common/utils/observable';
import { DocumentHistory, HistoryContext, IHistoryContextProvider } from '../../../platform/inlineEdits/common/workspaceEditTracker/historyContextProvider';
import { NesXtabHistoryTracker } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILogService } from '../../../platform/log/common/logService';
import { ISnippyService } from '../../../platform/snippy/common/snippyService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Result } from '../../../util/common/result';
import { createTracer, ITracer } from '../../../util/common/tracing';
import { assert } from '../../../util/vs/base/common/assert';
import { DeferredPromise, timeout, TimeoutTimer } from '../../../util/vs/base/common/async';
import { CachedFunction } from '../../../util/vs/base/common/cache';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { BugIndicatingError } from '../../../util/vs/base/common/errors';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { LRUCache } from '../../../util/vs/base/common/map';
import { mapObservableArrayCached, runOnChange } from '../../../util/vs/base/common/observable';
import { assertType } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { LineEdit } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { checkEditConsistency } from '../common/editRebase';
import { RejectionCollector } from '../common/rejectionCollector';
import { DebugRecorder } from './debugRecorder';
import { INesConfigs } from './nesConfigs';
import { CachedOrRebasedEdit, NextEditCache } from './nextEditCache';
import { LlmNESTelemetryBuilder } from './nextEditProviderTelemetry';
import { INextEditResult, NextEditResult } from './nextEditResult';

export interface INextEditProvider<T extends INextEditResult, TTelemetry, TData = void> extends IDisposable {
	readonly ID: string;
	getNextEdit(docId: DocumentId, context: vscode.InlineCompletionContext, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken, telemetryBuilder: TTelemetry, data?: TData): Promise<T>;
	handleShown(suggestion: T): void;
	handleAcceptance(docId: DocumentId, suggestion: T): void;
	handleRejection(docId: DocumentId, suggestion: T): void;
	handleIgnored(docId: DocumentId, suggestion: T, supersededByRequestUuid: INextEditResult | undefined): void;
	lastRejectionTime: number;
	lastTriggerTime: number;
}

interface ProcessedDoc {
	recentEdit: RootedEdit<StringEdit>;
	nextEditDoc: StatelessNextEditDocument;
	documentAfterEdits: StringText;
}

export class NextEditProvider extends Disposable implements INextEditProvider<NextEditResult, LlmNESTelemetryBuilder> {

	public readonly ID = this._statelessNextEditProvider.ID;

	private readonly _rejectionCollector = new RejectionCollector(this._workspace, s => this._logService.trace(s));
	private readonly _nextEditCache: NextEditCache;
	private readonly _recentlyShownCache = new RecentlyShownCache();

	private _pendingStatelessNextEditRequest: StatelessNextEditRequest<CachedOrRebasedEdit> | null = null;

	private _lastShownTime = 0;

	private _lastRejectionTime = 0;
	public get lastRejectionTime() {
		return this._lastRejectionTime;
	}

	private _lastTriggerTime = 0;
	public get lastTriggerTime() {
		return this._lastTriggerTime;
	}

	private _tracer: ITracer;

	constructor(
		private readonly _workspace: ObservableWorkspace,
		private readonly _statelessNextEditProvider: IStatelessNextEditProvider,
		private readonly _historyContextProvider: IHistoryContextProvider,
		private readonly _xtabHistoryTracker: NesXtabHistoryTracker,
		private readonly _debugRecorder: DebugRecorder | undefined,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@ISnippyService private readonly _snippyService: ISnippyService,
		@ILogService private readonly _logService: ILogService,
		@IExperimentationService private readonly _expService: IExperimentationService,
	) {
		super();

		this._tracer = createTracer(['NES', 'NextEditProvider'], (s) => this._logService.trace(s));
		this._nextEditCache = new NextEditCache(this._workspace, this._logService);

		mapObservableArrayCached(this, this._workspace.openDocuments, (doc, store) => {
			store.add(runOnChange(doc.value, (value) => {
				this._cancelPendingRequestDueToDocChange(doc.id, value);
			}));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	private _cancelPendingRequestDueToDocChange(docId: DocumentId, docValue: StringText) {
		const isAsyncCompletions = this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsAsyncCompletions, this._expService);
		if (isAsyncCompletions || this._pendingStatelessNextEditRequest === null) {
			return;
		}
		const activeDoc = this._pendingStatelessNextEditRequest.getActiveDocument();
		if (activeDoc.id === docId && activeDoc.documentAfterEdits.value !== docValue.value) {
			this._pendingStatelessNextEditRequest.cancellationTokenSource.cancel();
		}
	}

	public async getNextEdit(docId: DocumentId, context: vscode.InlineCompletionContext, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken, telemetryBuilder: LlmNESTelemetryBuilder): Promise<NextEditResult> {
		const tracer = this._tracer.sub('getNextEdit');

		this._lastTriggerTime = Date.now();

		logContext.setStatelessNextEditProviderId(this._statelessNextEditProvider.ID);

		const doc = this._workspace.getDocument(docId);
		if (!doc) {
			tracer.throws(`Document "${docId}" not found`);
			throw new BugIndicatingError(`Document "${docId}" not found`); // FIXME@ulugbekna: currently this's not reported in telemetry
		}

		const documentAtInvocationTime = doc.value.get();

		const nesConfigs: INesConfigs = {
			isAsyncCompletions: this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsAsyncCompletions, this._expService),
			isRevisedCacheStrategy: this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsRevisedCacheStrategy, this._expService),
			isCacheTracksRejections: this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsCacheTracksRejections, this._expService),
			isRecentlyShownCacheEnabled: this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsRecentlyShownCacheEnabled, this._expService),
			debounceUseCoreRequestTime: this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsDebounceUseCoreRequestTime, this._expService),
		};

		telemetryBuilder.setNESConfigs({ ...nesConfigs });
		logContext.addCodeblockToLog(JSON.stringify(nesConfigs, null, '\t'));

		const recentlyShownCachedEdit = this._recentlyShownCache.get(docId, documentAtInvocationTime);
		const cachedEdit = this._nextEditCache.lookupNextEdit(docId, documentAtInvocationTime, doc.selection.get(), nesConfigs);

		if (cachedEdit?.rejected) {
			tracer.trace('cached edit was previously rejected');
			telemetryBuilder.setStatus('previouslyRejectedCache');
			telemetryBuilder.setWasPreviouslyRejected();
			const nextEditResult = new NextEditResult(logContext.requestId, cachedEdit.source, undefined);
			return nextEditResult;
		}

		let edit: StringReplacement | undefined;
		let currentDocument: StringText | undefined;
		let throwingError: Error | undefined;
		let req: NextEditFetchRequest;
		let targetDocumentId = docId;

		const cacheDelay = this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsCacheDelay, this._expService);

		if (recentlyShownCachedEdit) {
			tracer.trace('using recently shown cached edit');
			edit = recentlyShownCachedEdit[0];
			req = recentlyShownCachedEdit[1];
			logContext.setIsCachedResult(req.log);
			currentDocument = documentAtInvocationTime;
			telemetryBuilder.setHeaderRequestId(req.headerRequestId);
			telemetryBuilder.setIsFromCache();
			// TODO
			// telemetryBuilder.setSubsequentEditOrder(cachedEdit.subsequentN);
			// back-date the recording bookmark of the cached edit to the bookmark of the original request.
			logContext.recordingBookmark = req.log.recordingBookmark;

			await timeout(cacheDelay);

		} else if (cachedEdit) {
			tracer.trace('using cached edit');
			edit = cachedEdit.rebasedEdit || cachedEdit.edit;
			req = cachedEdit.source;
			logContext.setIsCachedResult(cachedEdit.source.log);
			currentDocument = documentAtInvocationTime;
			telemetryBuilder.setHeaderRequestId(req.headerRequestId);
			telemetryBuilder.setIsFromCache();
			telemetryBuilder.setSubsequentEditOrder(cachedEdit.rebasedEditIndex ?? cachedEdit.subsequentN);
			// back-date the recording bookmark of the cached edit to the bookmark of the original request.
			logContext.recordingBookmark = req.log.recordingBookmark;

			await timeout(cacheDelay);

		} else {
			tracer.trace('fetching next edit');
			req = new NextEditFetchRequest(logContext, nesConfigs.debounceUseCoreRequestTime ? (context.requestIssuedDateTime ?? undefined) : undefined);
			telemetryBuilder.setHeaderRequestId(req.headerRequestId);

			const startVersion = doc.value.get();
			tracer.trace('awaiting firstEdit promise');
			const result = await this.fetchNextEdit(req, doc, nesConfigs, telemetryBuilder, cancellationToken);
			tracer.trace('resolved firstEdit promise');
			const latency = `First edit latency: ${Date.now() - this._lastTriggerTime} ms`;
			logContext.addLog(latency);
			tracer.trace(latency);

			if (result.isError()) {
				tracer.trace(`failed to fetch next edit ${result.err.kind}${(result.err as any).message ? ` (${(result.err as any).message})` : ''}`);
				telemetryBuilder.setStatus(`noEdit:${result.err.kind}`);
				if (result.err instanceof NoNextEditReason.FetchFailure || result.err instanceof NoNextEditReason.Unexpected) {
					throwingError = result.err.error;
				}
			} else {
				targetDocumentId = result.val.docId ?? targetDocumentId;
				const targetDoc = targetDocumentId ? this._workspace.getDocument(targetDocumentId)! : doc;
				currentDocument = targetDoc.value.get();
				const docDidChange = targetDocumentId === doc.id && startVersion.value !== currentDocument.value;

				if (docDidChange) {
					tracer.trace('document changed while fetching next edit');
					telemetryBuilder.setStatus('docChanged');
					logContext.setIsSkipped();
				} else {
					const suggestedNextEdit = result.val.rebasedEdit || result.val.edit;
					if (!suggestedNextEdit) {
						tracer.trace('empty edits');
						telemetryBuilder.setStatus('emptyEdits');
					} else {
						tracer.trace('fetch succeeded');
						logContext.setResponseResults([suggestedNextEdit]); // TODO: other streamed edits?
						edit = suggestedNextEdit;
					}
				}
			}
		}

		telemetryBuilder.markEndTime();

		if (throwingError) {
			tracer.throws('has throwing error', throwingError);
			logContext.setError(throwingError);
			throw throwingError;
		}

		if (!edit || cancellationToken.isCancellationRequested) {
			tracer.trace(edit ? 'cancelled' : 'had no edit');
			const nextEditResult = new NextEditResult(logContext.requestId, req, undefined);
			return nextEditResult;
		}

		if (this._rejectionCollector.isRejected(docId, edit) || currentDocument && this._nextEditCache.isRejectedNextEdit(docId, currentDocument, edit, nesConfigs)) {
			tracer.trace('edit was previously rejected');
			telemetryBuilder.setStatus('previouslyRejected');
			telemetryBuilder.setWasPreviouslyRejected();
			const nextEditResult = new NextEditResult(logContext.requestId, req, undefined);
			return nextEditResult;
		}

		assert(currentDocument !== undefined, 'should be defined if edit is defined');

		telemetryBuilder.setStatus('notAccepted'); // Acceptance pending.
		const showRangePreference = this._statelessNextEditProvider.showNextEditPreference ?? ShowNextEditPreference.AroundEdit;
		const nextEditResult = new NextEditResult(logContext.requestId, req, { edit, showRangePreference, documentBeforeEdits: currentDocument, targetDocumentId });

		if (nesConfigs.isRecentlyShownCacheEnabled && !edit.isEmpty) {
			tracer.trace('edit is not neutral');
			this._recentlyShownCache.add(docId, currentDocument, [edit, req]);
		}

		tracer.trace('returning next edit result');
		telemetryBuilder.setHasNextEdit(true);

		return nextEditResult;
	}

	private _processDoc(doc: DocumentHistory): ProcessedDoc {
		const documentLinesBeforeEdit = doc.lastEdit.base.getLines();

		const recentEdits = doc.lastEdits;

		const recentEdit = RootedLineEdit.fromEdit(new RootedEdit(doc.lastEdit.base, doc.lastEdits.compose())).removeCommonSuffixPrefixLines().edit;

		const documentBeforeEdits = doc.lastEdit.base;

		const lastSelectionInAfterEdits = doc.lastSelection;

		const workspaceRoot = this._workspace.getWorkspaceRoot(doc.docId);

		const nextEditDoc = new StatelessNextEditDocument(
			doc.docId,
			workspaceRoot,
			doc.languageId,
			documentLinesBeforeEdit,
			recentEdit,
			documentBeforeEdits,
			recentEdits,
			lastSelectionInAfterEdits,
		);

		return {
			recentEdit: doc.lastEdit,
			nextEditDoc,
			documentAfterEdits: nextEditDoc.documentAfterEdits,
		};
	}

	private async fetchNextEdit(req: NextEditFetchRequest, doc: IObservableDocument, nesConfigs: INesConfigs, telemetryBuilder: LlmNESTelemetryBuilder, cancellationToken: CancellationToken): Promise<Result<CachedOrRebasedEdit, NoNextEditReason>> {
		const curDocId = doc.id;
		const tracer = this._tracer.sub('fetchNextEdit');
		const historyContext = this._historyContextProvider.getHistoryContext(curDocId);

		if (!historyContext) {
			return Result.error(new NoNextEditReason.Unexpected(new Error('DocumentMissingInHistoryContext')));
		}

		const documentAtInvocationTime = doc.value.get();
		const selectionAtInvocationTime = doc.selection.get();

		const logContext = req.log;

		logContext.setRecentEdit(historyContext);

		const pendingRequestStillCurrent = documentAtInvocationTime.value === this._pendingStatelessNextEditRequest?.documentBeforeEdits.value;
		const existingNextEditRequest = (pendingRequestStillCurrent || nesConfigs.isAsyncCompletions) && !this._pendingStatelessNextEditRequest?.cancellationTokenSource.token.isCancellationRequested
			&& this._pendingStatelessNextEditRequest || undefined;
		if (existingNextEditRequest) {
			// Nice! No need to make another request, we can reuse the result from a pending request.

			const nextEditResult = await this._joinNextEditRequest(existingNextEditRequest, telemetryBuilder, logContext, cancellationToken);

			if (pendingRequestStillCurrent) {
				telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
				return nextEditResult.nextEdit.isError() ? nextEditResult.nextEdit : existingNextEditRequest.firstEdit.p;
			} else {
				// Needs rebasing.
				const cacheResult = await existingNextEditRequest.firstEdit.p;
				if (cacheResult.isOk() && cacheResult.val.edit) {
					const rebasedCachedEdit = this._nextEditCache.tryRebaseCacheEntry(cacheResult.val, documentAtInvocationTime, selectionAtInvocationTime, nesConfigs);
					if (rebasedCachedEdit) {
						telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
						return Result.ok(rebasedCachedEdit);
					}
				}

				if (cancellationToken.isCancellationRequested) {
					tracer.trace('document changed after rebase failed');
					telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
					return Result.error(new NoNextEditReason.GotCancelled('afterFailedRebase'));
				}

				// Rebase failed (or result had error). Check if there is a new pending request. Otherwise continue with a new request below.
				const pendingRequestStillCurrent = documentAtInvocationTime.value === this._pendingStatelessNextEditRequest?.documentBeforeEdits.value;
				const existingNextEditRequest2 = pendingRequestStillCurrent && !this._pendingStatelessNextEditRequest?.cancellationTokenSource.token.isCancellationRequested
					&& this._pendingStatelessNextEditRequest || undefined;
				if (existingNextEditRequest2) {
					tracer.trace('reusing 2nd existing next edit request after rebase failed');
					const nextEditResult = await this._joinNextEditRequest(existingNextEditRequest2, telemetryBuilder, logContext, cancellationToken);
					telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
					return nextEditResult.nextEdit.isError() ? nextEditResult.nextEdit : existingNextEditRequest2.firstEdit.p;
				}

				tracer.trace('creating new next edit request after rebase failed');
			}
		}

		const res = await this._executeNewNextEditRequest(req, doc, historyContext, nesConfigs, telemetryBuilder, cancellationToken);
		const nextEditRequest = res.nextEditRequest;
		const nextEditResult = res.nextEditResult;
		telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
		return nextEditResult.nextEdit.isError() ? nextEditResult.nextEdit : nextEditRequest.firstEdit.p;
	}

	private async _joinNextEditRequest(nextEditRequest: StatelessNextEditRequest, telemetryBuilder: LlmNESTelemetryBuilder, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken) {
		// TODO: Will the telemetry look alright in this case?
		telemetryBuilder.setHeaderRequestId(nextEditRequest.id);
		telemetryBuilder.setIsFromCache();

		telemetryBuilder.setRequest(nextEditRequest);
		logContext.setRequestInput(nextEditRequest);
		logContext.setIsCachedResult(nextEditRequest.logContext);

		const disp = this._hookupCancellation(nextEditRequest, cancellationToken);
		try {
			return await nextEditRequest.result;
		} finally {
			disp.dispose();
		}
	}

	private async _executeNewNextEditRequest(
		req: NextEditFetchRequest,
		doc: IObservableDocument,
		historyContext: HistoryContext,
		nesConfigs: INesConfigs,
		telemetryBuilder: LlmNESTelemetryBuilder,
		cancellationToken: CancellationToken
	) {
		const curDocId = doc.id;
		const tracer = this._tracer.sub('_executeNewNextEditRequest');

		const recording = this._debugRecorder?.getRecentLog();

		const logContext = req.log;

		const activeDocAndIdx = assertDefined(historyContext.getDocumentAndIdx(curDocId));
		const activeDocSelection = doc.selection.get()[0] as OffsetRange | undefined;

		const projectedDocuments = historyContext.documents.map(doc => this._processDoc(doc));

		const xtabEditHistory = this._xtabHistoryTracker.getHistory();

		function convertLineEditToEdit(nextLineEdit: LineEdit, docId: DocumentId): StringEdit {
			const doc = projectedDocuments.find(d => d.nextEditDoc.id === docId)!;
			const rootedLineEdit = new RootedLineEdit(doc.documentAfterEdits, nextLineEdit);
			const suggestedEdit = rootedLineEdit.toEdit();
			return suggestedEdit;
		}

		const firstEdit = new DeferredPromise<Result<CachedOrRebasedEdit, NoNextEditReason>>();

		const nextEditRequest = new StatelessNextEditRequest(
			req.headerRequestId,
			doc.value.get(),
			projectedDocuments.map(d => d.nextEditDoc),
			activeDocAndIdx.idx,
			xtabEditHistory,
			firstEdit,
			logContext,
			req.log.recordingBookmark,
			recording,
			req.providerRequestStartDateTime,
		);
		let nextEditResult: StatelessNextEditResult | undefined;

		if (this._pendingStatelessNextEditRequest) {
			this._pendingStatelessNextEditRequest.cancellationTokenSource.cancel();
			this._pendingStatelessNextEditRequest = null;
		}

		this._pendingStatelessNextEditRequest = nextEditRequest;

		const removeFromPending = () => {
			if (this._pendingStatelessNextEditRequest === nextEditRequest) {
				this._pendingStatelessNextEditRequest = null;
			}
		};

		telemetryBuilder.setRequest(nextEditRequest);
		telemetryBuilder.setStatus('requested');
		logContext.setRequestInput(nextEditRequest);

		// A note on cancellation:
		//
		// We don't cancel when the cancellation token is signalled, because we have our own
		// separate cancellation logic which ends up cancelling based on documents changing.
		//
		// But we do cancel requests which didn't start yet if no-one really needs their result
		//
		const disp = this._hookupCancellation(nextEditRequest, cancellationToken, nesConfigs.isAsyncCompletions ? autorunWithChanges(this, {
			value: doc.value,
		}, data => {
			data.value.changes.forEach(edit => {
				if (nextEditRequest.intermediateUserEdit && !edit.isEmpty()) {
					nextEditRequest.intermediateUserEdit = nextEditRequest.intermediateUserEdit.compose(edit);
					if (!checkEditConsistency(nextEditRequest.documentBeforeEdits.value, nextEditRequest.intermediateUserEdit, data.value.value.value, tracer)) {
						nextEditRequest.intermediateUserEdit = undefined;
					}
				}
			});
		}) : undefined);

		const createPushEdit = (): PushEdit => {
			this._tracer.sub('createPushEdit');
			let ithEdit = -1;
			const statePerDoc = new CachedFunction((id: DocumentId) => {
				const doc = projectedDocuments.find(d => d.nextEditDoc.id === id);
				if (!doc) {
					throw new BugIndicatingError();
				}
				return {
					docContents: doc.documentAfterEdits,
					editsSoFar: StringEdit.empty,
					nextEdits: [] as StringReplacement[],
					docId: id,
				};
			});
			const pushEdit: PushEdit = (result) => {
				const tracer = this._tracer.sub('pushEdit');

				++ithEdit;
				tracer.trace(`processing edit #${ithEdit} (starts at 0)`);

				if (result.isError()) { // either error or stream of edits ended
					if (statePerDoc.get(curDocId).nextEdits.length) {
						tracer.returns(`${statePerDoc.get(curDocId).nextEdits.length} edits returned`);
					} else {
						tracer.returns(`no edit, reason: ${result.err.kind}`);
						if (result.err instanceof NoNextEditReason.NoSuggestions) {
							const { documentBeforeEdits, window } = result.err;
							let reducedWindow = window;
							if (activeDocSelection && window) {
								const cursorOffset = activeDocSelection.endExclusive;
								const t = documentBeforeEdits.getTransformer();
								const cursorPosition = t.getPosition(cursorOffset);
								const lineOffset = t.getOffset(cursorPosition.with(undefined, 1));
								const lineEndOffset = t.getOffset(cursorPosition.with(undefined, t.getLineLength(cursorPosition.lineNumber) + 1));
								const reducedOffset = t.getOffset(t.getPosition(window.start).delta(1));
								const reducedEndPosition = t.getPosition(window.endExclusive).delta(-2);
								const reducedEndOffset = t.getOffset(reducedEndPosition.column > 1 ? reducedEndPosition.with(undefined, t.getLineLength(reducedEndPosition.lineNumber) + 1) : reducedEndPosition);
								reducedWindow = new OffsetRange(
									Math.min(reducedOffset, lineOffset),
									Math.max(reducedEndOffset, lineEndOffset)
								);
							}
							this._nextEditCache.setNoNextEdit(curDocId, documentBeforeEdits, reducedWindow, req, nesConfigs);
						}
					}
					{
						disp.dispose();
						removeFromPending();
					}
					if (!firstEdit.isSettled) {
						firstEdit.complete(result);
					}
					return;
				}

				const targetDocState = statePerDoc.get(result.val.targetDocument ?? curDocId);

				const singleLineEdit = result.val.edit;
				const lineEdit = new LineEdit([singleLineEdit]);
				const edit = convertLineEditToEdit(lineEdit, targetDocState.docId);
				const rebasedEdit = edit.tryRebase(targetDocState.editsSoFar);

				if (rebasedEdit === undefined) {
					tracer.trace(`edit ${ithEdit} is undefined after rebasing`);
					if (!firstEdit.isSettled) {
						firstEdit.complete(Result.error(new NoNextEditReason.Uncategorized(new Error('Rebased edit is undefined'))));
					}
					return;
				}

				targetDocState.editsSoFar = targetDocState.editsSoFar.compose(rebasedEdit);

				let cachedEdit;
				if (rebasedEdit.replacements.length === 0) {
					tracer.trace(`WARNING: ${ithEdit} has no edits`);
				} else if (rebasedEdit.replacements.length > 1) {
					tracer.trace(`WARNING: ${ithEdit} has ${rebasedEdit.replacements.length} edits, but expected only 1`);
				} else {
					// populate the cache
					const nextEdit = rebasedEdit.replacements[0];
					targetDocState.nextEdits.push(nextEdit);
					cachedEdit = this._nextEditCache.setKthNextEdit(targetDocState.docId, targetDocState.docContents, ithEdit === 0 ? result.val.window : undefined, nextEdit, ithEdit, ithEdit === 0 ? targetDocState.nextEdits : undefined, ithEdit === 0 ? nextEditRequest.intermediateUserEdit : undefined, req);
					tracer.trace(`populated cache for ${ithEdit}`);
				}

				if (!firstEdit.isSettled) {
					tracer.trace('resolving firstEdit promise');
					logContext.setResult(new RootedLineEdit(targetDocState.docContents, lineEdit)); // this's correct without rebasing because this's the first edit
					firstEdit.complete(cachedEdit ? Result.ok(cachedEdit) : Result.error(new NoNextEditReason.Unexpected(new Error('No cached edit'))));
				}

				targetDocState.docContents = rebasedEdit.applyOnText(targetDocState.docContents);
			};

			return pushEdit;
		};
		const pushEdit = createPushEdit();
		try {
			nextEditResult = await this._statelessNextEditProvider.provideNextEdit(nextEditRequest, pushEdit, logContext, nextEditRequest.cancellationTokenSource.token);
			nextEditRequest.setResult(nextEditResult);
		} catch (err) {
			nextEditRequest.setResultError(err);
			throw err;
		} finally {
			if (!nextEditResult || nextEditResult.nextEdit.isError()) {
				// when streaming, we need to keep the response going unless UI cancels it
				// if we remove it from pending here, when UI cancels, we cannot cancel it because we think that the request has finished
				disp.dispose();
				removeFromPending();
			}
		}
		return { nextEditRequest, nextEditResult };
	}

	private _hookupCancellation(nextEditRequest: StatelessNextEditRequest, cancellationToken: CancellationToken, attachedDisposable?: IDisposable): IDisposable {
		const disposables = new DisposableStore();

		let dependantRemoved = false;
		const removeDependant = () => {
			if (!dependantRemoved) {
				dependantRemoved = true;
				nextEditRequest.liveDependentants--;
			}
		};

		const cancellationTimer = disposables.add(new TimeoutTimer());

		disposables.add(cancellationToken.onCancellationRequested(() => {
			removeDependant();
			if (nextEditRequest.liveDependentants > 0) {
				// there are others depending on this request
				return;
			}
			if (!nextEditRequest.fetchIssued) {
				// fetch not issued => cancel!
				nextEditRequest.cancellationTokenSource.cancel();
				attachedDisposable?.dispose();
				return;
			}
			cancellationTimer.setIfNotSet(() => {
				if (nextEditRequest.liveDependentants > 0) {
					// there are others depending on this request
					return;
				}
				nextEditRequest.cancellationTokenSource.cancel();
				attachedDisposable?.dispose();
			}, 1000); // This needs to be longer than the pause between two requests from Core otherwise we cancel running requests too early.
		}));

		disposables.add(toDisposable(() => {
			removeDependant();
			if (nextEditRequest.liveDependentants === 0) {
				attachedDisposable?.dispose();
			}
		}));

		nextEditRequest.liveDependentants++;

		return disposables;
	}

	public handleShown(suggestion: NextEditResult) {
		this._lastShownTime = Date.now();
	}

	public handleAcceptance(docId: DocumentId, suggestion: NextEditResult) {
		this.runSnippy(docId, suggestion);
		this._statelessNextEditProvider.handleAcceptance?.();
	}

	public handleRejection(docId: DocumentId, suggestion: NextEditResult) {
		assertType(suggestion.result, '@ulugbekna: undefined edit cannot be rejected?');

		const shownDuration = Date.now() - this._lastShownTime;
		if (shownDuration > 1000 && suggestion.result) {
			// we can argue that the user had the time to review this
			// so it wasn't an accidental rejection
			this._recentlyShownCache.remove(suggestion.result.edit);
			this._rejectionCollector.reject(docId, suggestion.result.edit);
			if (this._configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsCacheTracksRejections, this._expService)) {
				this._nextEditCache.rejectedNextEdit(suggestion.source.headerRequestId);
			}
		}

		this._lastRejectionTime = Date.now();

		this._statelessNextEditProvider.handleRejection?.();
	}

	public handleIgnored(docId: DocumentId, suggestion: NextEditResult, supersededBy: INextEditResult | undefined): void { }

	private async runSnippy(docId: DocumentId, suggestion: NextEditResult) {
		if (suggestion.result === undefined) {
			return;
		}
		this._snippyService.handlePostInsertion(docId.toUri(), suggestion.result.documentBeforeEdits, suggestion.result.edit);
	}

	public clearCache() {
		this._nextEditCache.clear();
		this._recentlyShownCache.clear();
		this._rejectionCollector.clear();
	}
}

function assertDefined<T>(value: T | undefined): T {
	if (!value) {
		throw new BugIndicatingError('expected value to be defined, but it was not');
	}
	return value;
}

export class NextEditFetchRequest {
	public readonly headerRequestId = generateUuid();
	constructor(
		public readonly log: InlineEditRequestLogContext,
		public readonly providerRequestStartDateTime: number | undefined,
	) {
	}
}

class RecentlyShownCache {
	private readonly _cache = new LRUCache<string, [StringReplacement, NextEditFetchRequest]>(10);

	add(docId: DocumentId, documentBeforeEdits: StringText, edit: [StringReplacement, NextEditFetchRequest]) {
		const key = this._key(docId, documentBeforeEdits);
		this._cache.set(key, edit);
	}

	get(docId: DocumentId, documentContent: StringText): [StringReplacement, NextEditFetchRequest] | undefined {
		const key = this._key(docId, documentContent);
		return this._cache.get(key);
	}

	remove(edit: StringReplacement): void {
		for (const entry of this._cache) {
			if (entry[1][0] === edit) {
				this._cache.delete(entry[0]);
				break;
			}
		}
	}

	clear() {
		this._cache.clear();
	}

	private _key(docId: DocumentId, documentContent: StringText) {
		return docId.uri + ';' + documentContent.value;
	}
}
