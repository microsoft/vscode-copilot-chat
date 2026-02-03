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
import { ILogger, ILogService, LogTarget } from '../../../platform/log/common/logService';
import { ISnippyService } from '../../../platform/snippy/common/snippyService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ErrorUtils } from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { assert } from '../../../util/vs/base/common/assert';
import { DeferredPromise, timeout, TimeoutTimer } from '../../../util/vs/base/common/async';
import { CachedFunction } from '../../../util/vs/base/common/cache';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { BugIndicatingError } from '../../../util/vs/base/common/errors';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { mapObservableArrayCached, runOnChange } from '../../../util/vs/base/common/observable';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { assertType } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { LineEdit } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { checkEditConsistency } from '../common/editRebase';
import { NesChangeHint } from '../common/nesTriggerHint';
import { RejectionCollector } from '../common/rejectionCollector';
import { DebugRecorder } from './debugRecorder';
import { INesConfigs } from './nesConfigs';
import { CachedOrRebasedEdit, NextEditCache } from './nextEditCache';
import { LlmNESTelemetryBuilder } from './nextEditProviderTelemetry';
import { INextEditResult, NextEditResult } from './nextEditResult';

/**
 * Computes a reduced window range that encompasses both the original window (shrunk by one line
 * on each end) and the full line where the cursor is located.
 *
 * This ensures the cache invalidation window always includes the cursor's line while trimming
 * the edges of the original window.
 */
function computeReducedWindow(
	window: OffsetRange,
	activeDocSelection: OffsetRange | undefined,
	documentBeforeEdits: StringText
): OffsetRange {
	if (!activeDocSelection) {
		return window;
	}
	const cursorOffset = activeDocSelection.endExclusive;
	const t = documentBeforeEdits.getTransformer();
	const cursorPosition = t.getPosition(cursorOffset);
	const lineOffset = t.getOffset(cursorPosition.with(undefined, 1));
	const lineEndOffset = t.getOffset(cursorPosition.with(undefined, t.getLineLength(cursorPosition.lineNumber) + 1));
	const reducedOffset = t.getOffset(t.getPosition(window.start).delta(1));
	const reducedEndPosition = t.getPosition(window.endExclusive).delta(-2);
	const reducedEndOffset = t.getOffset(reducedEndPosition.column > 1 ? reducedEndPosition.with(undefined, t.getLineLength(reducedEndPosition.lineNumber) + 1) : reducedEndPosition);
	return new OffsetRange(
		Math.min(reducedOffset, lineOffset),
		Math.max(reducedEndOffset, lineEndOffset)
	);
}

function convertLineEditToEdit(nextLineEdit: LineEdit, projectedDocuments: readonly ProcessedDoc[], docId: DocumentId): StringEdit {
	const doc = projectedDocuments.find(d => d.nextEditDoc.id === docId)!;
	const rootedLineEdit = new RootedLineEdit(doc.documentAfterEdits, nextLineEdit);
	const suggestedEdit = rootedLineEdit.toEdit();
	return suggestedEdit;
}

export interface NESInlineCompletionContext extends vscode.InlineCompletionContext {
	enforceCacheDelay: boolean;
	changeHint?: NesChangeHint;
}

export interface INextEditProvider<T extends INextEditResult, TTelemetry, TData = void> extends IDisposable {
	readonly ID: string;
	getNextEdit(docId: DocumentId, context: NESInlineCompletionContext, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken, telemetryBuilder: TTelemetry, data?: TData): Promise<T>;
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

	private readonly _rejectionCollector = this._register(new RejectionCollector(this._workspace, this._logService));
	private readonly _nextEditCache: NextEditCache;

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

	private _lastNextEditResult: NextEditResult | undefined;
	private _shouldExpandEditWindow = false;

	private _logger: ILogger;

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

		this._logger = this._logService.createSubLogger(['NES', 'NextEditProvider']);
		this._nextEditCache = new NextEditCache(this._workspace, this._logService, this._configService, this._expService);

		mapObservableArrayCached(this, this._workspace.openDocuments, (doc, store) => {
			store.add(runOnChange(doc.value, (value) => {
				this._cancelPendingRequestDueToDocChange(doc.id, value);
			}));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	private _cancelPendingRequestDueToDocChange(docId: DocumentId, docValue: StringText) {
		const isAsyncCompletions = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsAsyncCompletions, this._expService);
		if (isAsyncCompletions || this._pendingStatelessNextEditRequest === null) {
			return;
		}
		const activeDoc = this._pendingStatelessNextEditRequest.getActiveDocument();
		if (activeDoc.id === docId && activeDoc.documentAfterEdits.value !== docValue.value) {
			this._pendingStatelessNextEditRequest.cancellationTokenSource.cancel();
		}
	}

	public async getNextEdit(
		docId: DocumentId,
		context: NESInlineCompletionContext,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
		telemetryBuilder: LlmNESTelemetryBuilder
	): Promise<NextEditResult> {
		const now = Date.now();

		this._lastTriggerTime = now;

		const sw = new StopWatch();

		const logger = this._logger.createSubLogger(context.requestUuid.substring(4, 8))
			.withExtraTarget(LogTarget.fromCallback((_level, msg) => {
				logContext.trace(`[${Math.floor(sw.elapsed()).toString().padStart(4, ' ')}ms] ${msg}`);
			}));

		const shouldExpandEditWindow = this._shouldExpandEditWindow;

		logContext.setStatelessNextEditProviderId(this._statelessNextEditProvider.ID);

		let result: NextEditResult;
		try {
			result = await this._getNextEditCanThrow(docId, context, now, shouldExpandEditWindow, logger, logContext, cancellationToken, telemetryBuilder);
		} catch (error) {
			logContext.setError(error);
			telemetryBuilder.setNextEditProviderError(ErrorUtils.toString(ErrorUtils.fromUnknown(error)));
			throw error;
		} finally {
			telemetryBuilder.markEndTime();
		}

		this._lastNextEditResult = result;

		return result;
	}

	private async _getNextEditCanThrow(
		docId: DocumentId,
		context: NESInlineCompletionContext,
		triggerTime: number,
		shouldExpandEditWindow: boolean,
		parentLogger: ILogger,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
		telemetryBuilder: LlmNESTelemetryBuilder
	): Promise<NextEditResult> {

		const logger = parentLogger.createSubLogger('_getNextEdit');
		logger.trace(`invoked with trigger id = ${context.changeHint === undefined ? 'undefined' : `uuid = ${context.changeHint.data.uuid}, reason = ${context.changeHint.data.reason}`}`);

		const doc = this._workspace.getDocument(docId);
		if (!doc) {
			logger.trace(`Document "${docId.baseName}" not found`);
			throw new BugIndicatingError(`Document "${docId.baseName}" not found`);
		}

		const documentAtInvocationTime = doc.value.get();
		const selections = doc.selection.get();

		const nesConfigs = this.determineNesConfigs(telemetryBuilder, logContext);

		const cachedEdit = this._nextEditCache.lookupNextEdit(docId, documentAtInvocationTime, selections, nesConfigs);
		if (cachedEdit?.rejected) {
			logger.trace('cached edit was previously rejected');
			telemetryBuilder.setStatus('previouslyRejectedCache');
			telemetryBuilder.setWasPreviouslyRejected();
			const nextEditResult = new NextEditResult(logContext.requestId, cachedEdit.source, undefined);
			return nextEditResult;
		}

		let edit: { actualEdit: StringReplacement; isFromCursorJump: boolean } | undefined;
		let currentDocument: StringText | undefined;
		let error: NoNextEditReason | undefined;
		let req: NextEditFetchRequest;
		let targetDocumentId = docId;

		let isRebasedCachedEdit = false;
		let isSubsequentCachedEdit = false;

		if (cachedEdit) {
			logger.trace('using cached edit');
			const actualEdit = cachedEdit.rebasedEdit || cachedEdit.edit;
			if (actualEdit) {
				edit = { actualEdit, isFromCursorJump: cachedEdit.isFromCursorJump };
			}
			isRebasedCachedEdit = !!cachedEdit.rebasedEdit;
			isSubsequentCachedEdit = cachedEdit.subsequentN !== undefined && cachedEdit.subsequentN > 0;
			req = cachedEdit.source;
			logContext.setIsCachedResult(cachedEdit.source.log);
			currentDocument = documentAtInvocationTime;
			telemetryBuilder.setHeaderRequestId(req.headerRequestId);
			telemetryBuilder.setIsFromCache();
			telemetryBuilder.setSubsequentEditOrder(cachedEdit.rebasedEditIndex ?? cachedEdit.subsequentN);
			// back-date the recording bookmark of the cached edit to the bookmark of the original request.
			logContext.recordingBookmark = req.log.recordingBookmark;

		} else {
			logger.trace(`fetching next edit with shouldExpandEditWindow=${shouldExpandEditWindow}`);
			const providerRequestStartDateTime = (this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsDebounceUseCoreRequestTime, this._expService)
				? (context.requestIssuedDateTime ?? undefined)
				: undefined);
			req = new NextEditFetchRequest(context.requestUuid, logContext, providerRequestStartDateTime);
			telemetryBuilder.setHeaderRequestId(req.headerRequestId);

			const startVersion = doc.value.get();
			logger.trace('awaiting firstEdit promise');
			const result = await this.fetchNextEdit(req, doc, nesConfigs, shouldExpandEditWindow, logger, telemetryBuilder, cancellationToken);
			logger.trace('resolved firstEdit promise');
			const latency = `First edit latency: ${Date.now() - this._lastTriggerTime} ms`;
			logContext.addLog(latency);
			logger.trace(latency);

			if (result.isError()) {
				logger.trace(`failed to fetch next edit ${result.err.toString()}`);
				telemetryBuilder.setStatus(`noEdit:${result.err.kind}`);
				error = result.err;
			} else {
				targetDocumentId = result.val.docId ?? targetDocumentId;
				const targetDoc = targetDocumentId ? this._workspace.getDocument(targetDocumentId)! : doc;
				currentDocument = targetDoc.value.get();
				const docDidChange = targetDocumentId === doc.id && startVersion.value !== currentDocument.value;

				if (docDidChange) {
					logger.trace('document changed while fetching next edit');
					telemetryBuilder.setStatus('docChanged');
					logContext.setIsSkipped();
				} else {
					const suggestedNextEdit = result.val.rebasedEdit || result.val.edit;
					if (!suggestedNextEdit) {
						logger.trace('empty edits');
						telemetryBuilder.setStatus('emptyEdits');
					} else {
						logger.trace('fetch succeeded');
						logContext.setResponseResults([suggestedNextEdit]); // TODO: other streamed edits?
						edit = { actualEdit: suggestedNextEdit, isFromCursorJump: result.val.isFromCursorJump };
					}
				}
			}
		}

		if (error instanceof NoNextEditReason.FetchFailure || error instanceof NoNextEditReason.Unexpected) {
			logger.trace(`has throwing error: ${error.error}`);
			throw error.error;
		} else if (error instanceof NoNextEditReason.NoSuggestions) {
			if (error.nextCursorPosition === undefined) {
				logContext.markAsNoSuggestions();
			} else {
				telemetryBuilder.setStatus('emptyEditsButHasNextCursorPosition');
				return new NextEditResult(logContext.requestId, req, { jumpToPosition: error.nextCursorPosition, documentBeforeEdits: documentAtInvocationTime, isFromCursorJump: false });
			}
		}

		const emptyResult = new NextEditResult(logContext.requestId, req, undefined);

		if (!edit) {
			logger.trace('had no edit');
			// telemetry builder status must've been set earlier
			return emptyResult;
		}

		if (cancellationToken.isCancellationRequested) {
			logger.trace('cancelled');
			telemetryBuilder.setStatus(`noEdit:gotCancelled`);
			return emptyResult;
		}

		if (this._rejectionCollector.isRejected(targetDocumentId, edit.actualEdit) || currentDocument && this._nextEditCache.isRejectedNextEdit(targetDocumentId, currentDocument, edit.actualEdit, nesConfigs)) {
			logger.trace('edit was previously rejected');
			telemetryBuilder.setStatus('previouslyRejected');
			telemetryBuilder.setWasPreviouslyRejected();
			return emptyResult;
		}

		logContext.setResult(RootedLineEdit.fromEdit(new RootedEdit(documentAtInvocationTime, new StringEdit([edit.actualEdit]))));

		assert(currentDocument !== undefined, 'should be defined if edit is defined');

		telemetryBuilder.setStatus('notAccepted'); // Acceptance pending.

		const showRangePreference = this._statelessNextEditProvider.showNextEditPreference ?? ShowNextEditPreference.AroundEdit;

		const nextEditResult = new NextEditResult(logContext.requestId, req, { edit: edit.actualEdit, isFromCursorJump: edit.isFromCursorJump, showRangePreference, documentBeforeEdits: currentDocument, targetDocumentId });

		telemetryBuilder.setHasNextEdit(true);

		const delay = this.computeMinimumResponseDelay({ triggerTime, isRebasedCachedEdit, isSubsequentCachedEdit, enforceCacheDelay: context.enforceCacheDelay }, logger);
		if (delay > 0) {
			await timeout(delay);
			if (cancellationToken.isCancellationRequested) {
				logger.trace('cancelled');
				telemetryBuilder.setStatus(`noEdit:gotCancelled`);
				return emptyResult;
			}
		}

		logger.trace('returning next edit result');
		return nextEditResult;
	}

	private determineNesConfigs(telemetryBuilder: LlmNESTelemetryBuilder, logContext: InlineEditRequestLogContext): INesConfigs {
		const nesConfigs: INesConfigs = {
			isAsyncCompletions: this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsAsyncCompletions, this._expService),
		};

		telemetryBuilder.setNESConfigs({ ...nesConfigs });
		logContext.addCodeblockToLog(JSON.stringify(nesConfigs, null, '\t'));

		return nesConfigs;
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

	private async fetchNextEdit(req: NextEditFetchRequest, doc: IObservableDocument, nesConfigs: INesConfigs, shouldExpandEditWindow: boolean, parentLogger: ILogger, telemetryBuilder: LlmNESTelemetryBuilder, cancellationToken: CancellationToken): Promise<Result<CachedOrRebasedEdit, NoNextEditReason>> {
		const curDocId = doc.id;
		const logger = parentLogger.createSubLogger('fetchNextEdit');
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
					logger.trace('document changed after rebase failed');
					telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
					return Result.error(new NoNextEditReason.GotCancelled('afterFailedRebase'));
				}

				// Rebase failed (or result had error). Check if there is a new pending request. Otherwise continue with a new request below.
				const pendingRequestStillCurrent = documentAtInvocationTime.value === this._pendingStatelessNextEditRequest?.documentBeforeEdits.value;
				const existingNextEditRequest2 = pendingRequestStillCurrent && !this._pendingStatelessNextEditRequest?.cancellationTokenSource.token.isCancellationRequested
					&& this._pendingStatelessNextEditRequest || undefined;
				if (existingNextEditRequest2) {
					logger.trace('reusing 2nd existing next edit request after rebase failed');
					const nextEditResult = await this._joinNextEditRequest(existingNextEditRequest2, telemetryBuilder, logContext, cancellationToken);
					telemetryBuilder.setStatelessNextEditTelemetry(nextEditResult.telemetry);
					return nextEditResult.nextEdit.isError() ? nextEditResult.nextEdit : existingNextEditRequest2.firstEdit.p;
				}

				logger.trace('creating new next edit request after rebase failed');
			}
		}

		const res = await this._executeNewNextEditRequest(req, doc, historyContext, nesConfigs, shouldExpandEditWindow, logger, telemetryBuilder, cancellationToken);
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
		shouldExpandEditWindow: boolean,
		parentLogger: ILogger,
		telemetryBuilder: LlmNESTelemetryBuilder,
		cancellationToken: CancellationToken
	): Promise<{
		nextEditRequest: StatelessNextEditRequest<CachedOrRebasedEdit>;
		nextEditResult: StatelessNextEditResult;
	}> {
		const curDocId = doc.id;
		const logger = parentLogger.createSubLogger('_executeNewNextEditRequest');

		const recording = this._debugRecorder?.getRecentLog();

		const logContext = req.log;

		const activeDocAndIdx = assertDefined(historyContext.getDocumentAndIdx(curDocId));
		const activeDocSelection = doc.selection.get()[0] as OffsetRange | undefined;

		const projectedDocuments = historyContext.documents.map(doc => this._processDoc(doc));

		const xtabEditHistory = this._xtabHistoryTracker.getHistory();

		const firstEdit = new DeferredPromise<Result<CachedOrRebasedEdit, NoNextEditReason>>();

		const nLinesEditWindow = (shouldExpandEditWindow
			? this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsAutoExpandEditWindowLines, this._expService)
			: undefined);

		const nextEditRequest = new StatelessNextEditRequest(
			req.headerRequestId,
			req.opportunityId,
			doc.value.get(),
			projectedDocuments.map(d => d.nextEditDoc),
			activeDocAndIdx.idx,
			xtabEditHistory,
			firstEdit,
			nLinesEditWindow,
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
					if (!checkEditConsistency(nextEditRequest.documentBeforeEdits.value, nextEditRequest.intermediateUserEdit, data.value.value.value, logger)) {
						nextEditRequest.intermediateUserEdit = undefined;
					}
				}
			});
		}) : undefined);

		const createPushEdit = (): PushEdit => {
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
				const myLogger = logger.createSubLogger('pushEdit');

				++ithEdit;
				myLogger.trace(`processing edit #${ithEdit} (starts at 0)`);

				if (result.isError()) { // either error or stream of edits ended
					// if there was a request made, and it ended without any edits, reset shouldExpandEditWindow
					if (ithEdit === 0 && result.err instanceof NoNextEditReason.NoSuggestions) {
						myLogger.trace('resetting shouldExpandEditWindow to false due to NoSuggestions');
						this._shouldExpandEditWindow = false;
					}
					if (statePerDoc.get(curDocId).nextEdits.length) {
						myLogger.trace(`${statePerDoc.get(curDocId).nextEdits.length} edits returned`);
					} else {
						myLogger.trace(`no edit, reason: ${result.err.kind}`);
						if (result.err instanceof NoNextEditReason.NoSuggestions) {
							const { documentBeforeEdits, window } = result.err;
							const reducedWindow = window ? computeReducedWindow(window, activeDocSelection, documentBeforeEdits) : undefined;
							this._nextEditCache.setNoNextEdit(curDocId, documentBeforeEdits, reducedWindow, req);
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

				// reset shouldExpandEditWindow to false when we get any edit
				myLogger.trace('resetting shouldExpandEditWindow to false due to receiving an edit');
				this._shouldExpandEditWindow = false;

				const targetDocState = statePerDoc.get(result.val.targetDocument ?? curDocId);

				const singleLineEdit = result.val.edit;
				const lineEdit = new LineEdit([singleLineEdit]);
				const edit = convertLineEditToEdit(lineEdit, projectedDocuments, targetDocState.docId);
				const rebasedEdit = edit.tryRebase(targetDocState.editsSoFar);

				if (rebasedEdit === undefined) {
					myLogger.trace(`edit ${ithEdit} is undefined after rebasing`);
					if (!firstEdit.isSettled) {
						firstEdit.complete(Result.error(new NoNextEditReason.Uncategorized(new Error('Rebased edit is undefined'))));
					}
					return;
				}

				targetDocState.editsSoFar = targetDocState.editsSoFar.compose(rebasedEdit);

				let cachedEdit: CachedOrRebasedEdit | undefined;
				if (rebasedEdit.replacements.length === 0) {
					myLogger.trace(`WARNING: ${ithEdit} has no edits`);
				} else if (rebasedEdit.replacements.length > 1) {
					myLogger.trace(`WARNING: ${ithEdit} has ${rebasedEdit.replacements.length} edits, but expected only 1`);
				} else {
					// populate the cache
					const nextEdit = rebasedEdit.replacements[0];
					targetDocState.nextEdits.push(nextEdit);
					cachedEdit = this._nextEditCache.setKthNextEdit(
						targetDocState.docId,
						targetDocState.docContents,
						ithEdit === 0 ? result.val.window : undefined,
						nextEdit,
						ithEdit,
						ithEdit === 0 ? targetDocState.nextEdits : undefined,
						ithEdit === 0 ? nextEditRequest.intermediateUserEdit : undefined,
						req,
						{ isFromCursorJump: result.val.isFromCursorJump }
					);
					myLogger.trace(`populated cache for ${ithEdit}`);
				}

				if (!firstEdit.isSettled) {
					myLogger.trace('resolving firstEdit promise');
					logContext.setResult(new RootedLineEdit(targetDocState.docContents, lineEdit)); // this's correct without rebasing because this's the first edit
					firstEdit.complete(cachedEdit ? Result.ok(cachedEdit) : Result.error(new NoNextEditReason.Unexpected(new Error('No cached edit'))));
				}

				targetDocState.docContents = rebasedEdit.applyOnText(targetDocState.docContents);
			};

			return pushEdit;
		};
		const pushEdit = createPushEdit();
		try {
			nextEditResult = await this._statelessNextEditProvider.provideNextEdit(nextEditRequest, pushEdit, logger, logContext, nextEditRequest.cancellationTokenSource.token);
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

	private computeMinimumResponseDelay({ triggerTime, isRebasedCachedEdit, isSubsequentCachedEdit, enforceCacheDelay }: { triggerTime: number; isRebasedCachedEdit: boolean; isSubsequentCachedEdit: boolean; enforceCacheDelay: boolean }, logger: ILogger): number {

		if (!enforceCacheDelay) {
			logger.trace('[minimumDelay] no minimum delay enforced due to enforceCacheDelay being false');
			return 0;
		}

		const cacheDelay = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsCacheDelay, this._expService);
		const rebasedCacheDelay = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsRebasedCacheDelay, this._expService);
		const subsequentCacheDelay = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsSubsequentCacheDelay, this._expService);

		let minimumResponseDelay = cacheDelay;
		if (isRebasedCachedEdit && rebasedCacheDelay !== undefined) {
			minimumResponseDelay = rebasedCacheDelay;
		} else if (isSubsequentCachedEdit && subsequentCacheDelay !== undefined) {
			minimumResponseDelay = subsequentCacheDelay;
		}

		const nextEditProviderCallLatency = Date.now() - triggerTime;

		// if the provider call took longer than the minimum delay, we don't need to delay further
		const delay = Math.max(0, minimumResponseDelay - nextEditProviderCallLatency);

		logger.trace(`[minimumDelay] expected delay: ${minimumResponseDelay}ms, effective delay: ${delay}. isRebasedCachedEdit: ${isRebasedCachedEdit} (rebasedCacheDelay: ${rebasedCacheDelay}), isSubsequentCachedEdit: ${isSubsequentCachedEdit} (subsequentCacheDelay: ${subsequentCacheDelay})`);

		return delay;
	}

	public handleShown(suggestion: NextEditResult) {
		this._lastShownTime = Date.now();
	}

	public handleAcceptance(docId: DocumentId, suggestion: NextEditResult) {
		this.runSnippy(docId, suggestion);
		this._statelessNextEditProvider.handleAcceptance?.();

		const logger = this._logger.createSubLogger(suggestion.source.opportunityId.substring(4, 8)).createSubLogger('handleAcceptance');
		if (suggestion === this._lastNextEditResult) {
			logger.trace('setting shouldExpandEditWindow to true due to acceptance of last suggestion');
			this._shouldExpandEditWindow = true;
		} else {
			logger.trace('NOT setting shouldExpandEditWindow to true because suggestion is not the last suggestion');
		}
	}

	public handleRejection(docId: DocumentId, suggestion: NextEditResult) {
		assertType(suggestion.result, '@ulugbekna: undefined edit cannot be rejected?');

		const shownDuration = Date.now() - this._lastShownTime;
		if (shownDuration > 1000 && suggestion.result.edit) {
			// we can argue that the user had the time to review this
			// so it wasn't an accidental rejection
			this._rejectionCollector.reject(docId, suggestion.result.edit);
			this._nextEditCache.rejectedNextEdit(suggestion.source.headerRequestId);
		}

		this._lastRejectionTime = Date.now();

		this._statelessNextEditProvider.handleRejection?.();
	}

	public handleIgnored(docId: DocumentId, suggestion: NextEditResult, supersededBy: INextEditResult | undefined): void { }

	private async runSnippy(docId: DocumentId, suggestion: NextEditResult) {
		if (suggestion.result === undefined || suggestion.result.edit === undefined) {
			return;
		}
		this._snippyService.handlePostInsertion(docId.toUri(), suggestion.result.documentBeforeEdits, suggestion.result.edit);
	}

	public clearCache() {
		this._nextEditCache.clear();
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
		public readonly opportunityId: string,
		public readonly log: InlineEditRequestLogContext,
		public readonly providerRequestStartDateTime: number | undefined,
	) {
	}
}
