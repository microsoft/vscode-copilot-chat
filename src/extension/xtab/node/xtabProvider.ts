/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { FetchStreamSource } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchError, ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { toTextParts } from '../../../platform/chat/common/globalStringUtils';
import { ConfigKey, IConfigurationService, XTabProviderId } from '../../../platform/configuration/common/configurationService';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { createProxyXtabEndpoint } from '../../../platform/endpoint/node/proxyXtabEndpoint';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { LanguageContextEntry, LanguageContextResponse } from '../../../platform/inlineEdits/common/dataTypes/languageContext';
import * as xtabPromptOptions from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { ResponseProcessor } from '../../../platform/inlineEdits/common/responseProcessor';
import { NoNextEditReason, PushEdit, ShowNextEditPreference, StatelessNextEditDocument, StatelessNextEditRequest, StatelessNextEditResult, StatelessNextEditTelemetryBuilder } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ChainedStatelessNextEditProvider, IgnoreTriviaWhitespaceChangesAspect } from '../../../platform/inlineEdits/common/statelessNextEditProviders';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../platform/log/common/logService';
import { OptionalChatRequestParams, Prediction } from '../../../platform/networking/common/fetch';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ISimulationTestContext } from '../../../platform/simulationTestContext/common/simulationTestContext';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import * as errors from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { createTracer, ITracer } from '../../../util/common/tracing';
import { AsyncIterableObject, DeferredPromise, raceTimeout, timeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { LineEdit, LineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { Position } from '../../../util/vs/editor/common/core/position';
import { Range } from '../../../util/vs/editor/common/core/range';
import { LineRange } from '../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Position as VscodePosition } from '../../../vscodeTypes';
import { Delayer, DelaySession } from '../../inlineEdits/common/delayer';
import { editWouldDeleteWhatWasJustInserted } from '../../inlineEdits/common/ghNearbyNesProvider';
import { getOrDeduceSelectionFromLastEdit } from '../../inlineEdits/common/nearbyCursorInlineEditProvider';
import { IgnoreImportChangesAspect } from '../../inlineEdits/node/importFiltering';
import { AREA_AROUND_END_TAG, AREA_AROUND_START_TAG, CODE_TO_EDIT_END_TAG, CODE_TO_EDIT_START_TAG, createTaggedCurrentFileContentUsingPagedClipping, CURSOR_TAG, getUserPrompt, N_LINES_ABOVE, N_LINES_AS_CONTEXT, N_LINES_BELOW, nes41Miniv3SystemPrompt, simplifiedPrompt, systemPromptTemplate, unifiedModelSystemPrompt, xtab275SystemPrompt } from '../common/promptCrafting';
import { XtabEndpoint } from './xtabEndpoint';
import { linesWithBackticksRemoved, toLines } from './xtabUtils';

export const IGNORE_TEXT_BEFORE = /```[^\n]*\n/;

namespace ResponseTags {
	export const NO_CHANGE = {
		start: '<NO_CHANGE>'
	};
	export const EDIT = {
		start: '<EDIT>',
		end: '</EDIT>'
	};
	export const INSERT = {
		start: '<INSERT>',
		end: '</INSERT>'
	};
}

const enum RetryState {
	NotRetrying,
	RetryingWithExpandedWindow
}

export class XtabProvider extends ChainedStatelessNextEditProvider {

	public static readonly ID = XTabProviderId;

	public readonly dependsOnSelection = true;
	public readonly showNextEditPreference = ShowNextEditPreference.Always;

	private readonly tracer: ITracer;
	private readonly delayer: Delayer;

	private forceUseDefaultModel: boolean = false;

	constructor(
		@ISimulationTestContext private readonly simulationCtx: ISimulationTestContext,
		@IInstantiationService private readonly instaService: IInstantiationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IDiffService private readonly diffService: IDiffService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IExperimentationService private readonly expService: IExperimentationService,
		@ILogService private readonly logService: ILogService,
		@ILanguageContextProviderService private readonly langCtxService: ILanguageContextProviderService,
		@ILanguageDiagnosticsService private readonly langDiagService: ILanguageDiagnosticsService,
	) {
		super(XtabProvider.ID, [
			base => new IgnoreImportChangesAspect(base),
			base => new IgnoreTriviaWhitespaceChangesAspect(base),
		]);

		this.delayer = new Delayer(this.configService, this.expService);
		this.tracer = createTracer(['NES', 'XtabProvider'], (s) => this.logService.trace(s));
	}

	public handleAcceptance(): void {
		this.delayer.handleAcceptance();
	}

	public handleRejection(): void {
		this.delayer.handleRejection();
	}

	public async provideNextEditBase(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult> {
		const telemetry = new StatelessNextEditTelemetryBuilder(request);

		logContext.setProviderStartTime();
		try {
			if (request.xtabEditHistory.length === 0) {
				return StatelessNextEditResult.noEdit(new NoNextEditReason.ActiveDocumentHasNoEdits(), telemetry);
			}

			const delaySession = this.delayer.createDelaySession(request.providerRequestStartDateTime);

			const nextEditResult = await this.doGetNextEdit(request, pushEdit, delaySession, logContext, cancellationToken, telemetry, RetryState.NotRetrying);

			if (nextEditResult.isError() && nextEditResult.err instanceof NoNextEditReason.GotCancelled) {
				logContext.setIsSkipped();
			}

			if (nextEditResult.isOk()) {
				await this.enforceArtificialDelay(delaySession, telemetry);
			}

			return new StatelessNextEditResult(nextEditResult, telemetry.build(nextEditResult));
		} catch (err: unknown) {
			return StatelessNextEditResult.noEdit(new NoNextEditReason.Unexpected(errors.fromUnknown(err)), telemetry);
		} finally {
			logContext.setProviderEndTime();
		}
	}

	private async doGetNextEdit(
		request: StatelessNextEditRequest,
		pushEdit: PushEdit,
		delaySession: DelaySession,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
		telemetryBuilder: StatelessNextEditTelemetryBuilder,
		retryState: RetryState,
	): Promise<Result<void, NoNextEditReason>> {

		const tracer = this.tracer.sub('doGetNextEdit');

		const activeDocument = request.getActiveDocument();

		const selection = getOrDeduceSelectionFromLastEdit(activeDocument);

		if (selection === null) {
			return Result.error(new NoNextEditReason.Uncategorized(new Error('NoSelection')));
		}

		const endpoint = this.getEndpoint();
		logContext.setEndpointInfo(typeof endpoint.urlOrRequestMetadata === 'string' ? endpoint.urlOrRequestMetadata : JSON.stringify(endpoint.urlOrRequestMetadata.type), endpoint.model);
		telemetryBuilder.setModelName(endpoint.model);

		const computeTokens = (s: string) => Math.floor(s.length / 4);

		const cursorPosition = new Position(selection.endLineNumber, selection.endColumn);

		const cursorOffset = activeDocument.documentAfterEdits.getTransformer().getOffset(cursorPosition);

		const currentFileContent = activeDocument.documentAfterEdits;
		const currentFileContentLines = currentFileContent.getLines();

		const cursorLineIdx = cursorPosition.lineNumber - 1 /* to convert to 0-based */;

		const cursorLine = currentFileContentLines[cursorLineIdx];
		const isCursorAtEndOfLine = cursorPosition.column === cursorLine.trimEnd().length;
		if (isCursorAtEndOfLine) {
			delaySession.setExtraDebounce(this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsExtraDebounceEndOfLine, this.expService));
		}
		telemetryBuilder.setIsCursorAtLineEnd(isCursorAtEndOfLine);

		const areaAroundEditWindowLinesRange = this.computeAreaAroundEditWindowLinesRange(currentFileContentLines, cursorLineIdx);

		const editWindowLinesRange = this.computeEditWindowLinesRange(currentFileContentLines, cursorLineIdx, retryState);

		const cursorOriginalLinesOffset = Math.max(0, cursorLineIdx - editWindowLinesRange.start);
		const editWindowLastLineLength = activeDocument.documentAfterEdits.getTransformer().getLineLength(editWindowLinesRange.endExclusive);
		const editWindow = activeDocument.documentAfterEdits.getTransformer().getOffsetRange(new Range(editWindowLinesRange.start + 1, 1, editWindowLinesRange.endExclusive, editWindowLastLineLength + 1));

		const editWindowLines = currentFileContentLines.slice(editWindowLinesRange.start, editWindowLinesRange.endExclusive);

		// Expected: editWindow.substring(activeDocument.documentAfterEdits.value) === editWindowLines.join('\n')

		const doesIncludeCursorTag = editWindowLines.some(line => line.includes(CURSOR_TAG));
		const shouldRemoveCursorTagFromResponse = !doesIncludeCursorTag; // we'd like to remove the tag only if the original edit-window didn't include the tag

		const addCursorTagEdit = StringEdit.single(StringReplacement.insert(cursorOffset, CURSOR_TAG));
		const contentWithCursor = addCursorTagEdit.applyOnText(currentFileContent);
		const contentWithCursorLines = contentWithCursor.getLines();

		const editWindowWithCursorLines = contentWithCursorLines.slice(editWindowLinesRange.start, editWindowLinesRange.endExclusive);

		const areaAroundCodeToEdit = [
			AREA_AROUND_START_TAG,
			...contentWithCursorLines.slice(areaAroundEditWindowLinesRange.start, editWindowLinesRange.start),
			CODE_TO_EDIT_START_TAG,
			...editWindowWithCursorLines,
			CODE_TO_EDIT_END_TAG,
			...contentWithCursorLines.slice(editWindowLinesRange.endExclusive, areaAroundEditWindowLinesRange.endExclusive),
			AREA_AROUND_END_TAG
		].join('\n');

		let promptOptions: xtabPromptOptions.PromptOptions;

		if (this.forceUseDefaultModel) {
			promptOptions = xtabPromptOptions.DEFAULT_OPTIONS;
		} else {
			const promptingStrategy = this.determinePromptingStrategy({
				isXtabUnifiedModel: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabUseUnifiedModel, this.expService),
				isCodexV21NesUnified: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabCodexV21NesUnified, this.expService),
				useSimplifiedPrompt: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderUseSimplifiedPrompt, this.expService),
				useXtab275Prompting: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderUseXtab275Prompting, this.expService),
				useNes41Miniv3Prompting: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabUseNes41Miniv3Prompting, this.expService),
			});
			promptOptions = {
				promptingStrategy,
				currentFile: {
					maxTokens: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabCurrentFileMaxTokens, this.expService),
					includeTags: promptingStrategy !== xtabPromptOptions.PromptingStrategy.UnifiedModel /* unified model doesn't use tags in current file */ && this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabIncludeTagsInCurrentFile, this.expService),
					prioritizeAboveCursor: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabPrioritizeAboveCursor, this.expService)
				},
				pagedClipping: {
					pageSize: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabPageSize, this.expService)
				},
				recentlyViewedDocuments: {
					nDocuments: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabNRecentlyViewedDocuments, this.expService),
					maxTokens: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabRecentlyViewedDocumentsMaxTokens, this.expService),
					includeViewedFiles: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabIncludeViewedFiles, this.expService),
				},
				languageContext: {
					enabled: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabLanguageContextEnabled, this.expService),
					maxTokens: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabLanguageContextMaxTokens, this.expService),
				},
				diffHistory: {
					nEntries: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffNEntries, this.expService),
					maxTokens: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffMaxTokens, this.expService),
					onlyForDocsInPrompt: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffOnlyForDocsInPrompt, this.expService),
					useRelativePaths: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffUseRelativePaths, this.expService),
				}
			};
		}

		const areaAroundCodeToEditForCurrentFile = promptOptions.currentFile.includeTags
			? areaAroundCodeToEdit
			: [
				...contentWithCursorLines.slice(areaAroundEditWindowLinesRange.start, editWindowLinesRange.start),
				...editWindowLines,
				...contentWithCursorLines.slice(editWindowLinesRange.endExclusive, areaAroundEditWindowLinesRange.endExclusive),
			].join('\n');
		const { taggedCurrentFileContent, nLines: nLinesCurrentFile } = createTaggedCurrentFileContentUsingPagedClipping(
			currentFileContentLines,
			areaAroundCodeToEditForCurrentFile,
			areaAroundEditWindowLinesRange,
			computeTokens,
			promptOptions.pagedClipping.pageSize,
			promptOptions.currentFile,
		);
		telemetryBuilder.setNLinesOfCurrentFileInPrompt(nLinesCurrentFile);

		const recordingEnabled = this.configService.getConfig<boolean>(ConfigKey.Internal.InlineEditsLogContextRecorderEnabled);

		let langCtx: LanguageContextResponse | undefined;
		if (promptOptions.languageContext.enabled || recordingEnabled) {
			const langCtxPromise = this.getLanguageContext(request, delaySession, activeDocument, cursorPosition, logContext, cancellationToken, promptOptions);

			if (promptOptions.languageContext.enabled) {
				langCtx = await langCtxPromise;
			}

			if (recordingEnabled) {
				logContext.setFileDiagnostics(this.langDiagService.getAllDiagnostics());
				langCtxPromise.then(langCtxs => {
					if (langCtxs) {
						logContext.setLanguageContext(langCtxs);
					}
				});
			}
		}

		const userPrompt = getUserPrompt(request, taggedCurrentFileContent, areaAroundCodeToEdit, langCtx, computeTokens, promptOptions);

		const prediction = this.getPredictedOutput(editWindowLines, promptOptions.promptingStrategy);

		const messages = [
			{
				role: Raw.ChatRole.System,
				content: toTextParts(this.pickSystemPrompt(promptOptions.promptingStrategy))
			},
			{ role: Raw.ChatRole.User, content: toTextParts(userPrompt) }
		] satisfies Raw.ChatMessage[];

		logContext.setPrompt(messages);
		telemetryBuilder.setPrompt(messages);

		await this.debounce(delaySession, telemetryBuilder);
		if (cancellationToken.isCancellationRequested) {
			return Result.error(new NoNextEditReason.GotCancelled('afterDebounce'));
		}

		request.fetchIssued = true;

		const cursorLineOffset = cursorPosition.column;
		this.streamEdits(
			request,
			pushEdit,
			endpoint,
			messages,
			editWindow,
			editWindowLines,
			cursorOriginalLinesOffset,
			cursorLineOffset,
			editWindowLinesRange,
			prediction,
			{
				shouldRemoveCursorTagFromResponse,
				promptingStrategy: promptOptions.promptingStrategy,
				retryState,
			},
			delaySession,
			tracer,
			telemetryBuilder,
			logContext,
			cancellationToken
		);
		return Result.ok<void>(undefined);
	}

	private async getLanguageContext(
		request: StatelessNextEditRequest,
		delaySession: DelaySession,
		activeDocument: StatelessNextEditDocument,
		cursorPosition: Position,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
		promptOptions: xtabPromptOptions.PromptOptions
	): Promise<LanguageContextResponse | undefined> {
		try {
			const textDoc = this.workspaceService.textDocuments.find(doc => doc.uri.toString() === activeDocument.id.uri);
			if (textDoc === undefined) {
				return undefined;
			}

			const providers = this.langCtxService.getContextProviders(textDoc);
			if (providers.length < 1) {
				return undefined;
			}

			const debounceTime = delaySession.getDebounceTime();

			const cursorPositionVscode = new VscodePosition(cursorPosition.lineNumber - 1, cursorPosition.column - 1);

			const ctxRequest: Copilot.ResolveRequest = {
				completionId: request.id,
				documentContext: {
					uri: textDoc.uri.toString(),
					languageId: textDoc.languageId,
					version: textDoc.version,
					offset: textDoc.offsetAt(cursorPositionVscode)
				},
				activeExperiments: new Map(),
				timeBudget: debounceTime,
				timeoutEnd: Date.now() + debounceTime,
				source: 'nes',
			};
			const langCtxItems: LanguageContextEntry[] = [];
			const getContextPromise = async () => {
				const ctxIter = this.langCtxService.getContextItems(textDoc, ctxRequest, cancellationToken);
				for await (const item of ctxIter) {
					langCtxItems.push({ context: item, timeStamp: Date.now(), onTimeout: false });
				}
			};

			const start = Date.now();
			await raceTimeout(getContextPromise(), debounceTime);
			const end = Date.now();

			const langCtxOnTimeout = this.langCtxService.getContextItemsOnTimeout(textDoc, ctxRequest);
			langCtxItems.push(...langCtxOnTimeout.map(context => ({ context, timeStamp: end, onTimeout: true })));

			return { start, end, items: langCtxItems };

		} catch (error: unknown) {
			logContext.setError(errors.fromUnknown(error));
			this.tracer.trace(`Failed to fetch language context: ${error}`);
			return undefined;
		}
	}

	public async streamEdits(
		request: StatelessNextEditRequest,
		pushEdit: PushEdit,
		endpoint: IChatEndpoint,
		messages: Raw.ChatMessage[],
		editWindow: OffsetRange,
		editWindowLines: string[],
		cursorOriginalLinesOffset: number,
		cursorLineOffset: number, // cursor offset within the line it's in; 1-based
		editWindowLineRange: OffsetRange,
		prediction: Prediction | undefined,
		opts: {
			promptingStrategy: xtabPromptOptions.PromptingStrategy | undefined;
			shouldRemoveCursorTagFromResponse: boolean;
			retryState: RetryState;
		},
		delaySession: DelaySession,
		parentTracer: ITracer,
		telemetryBuilder: StatelessNextEditTelemetryBuilder,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
	) {
		const tracer = parentTracer.sub('streamEdits');

		const fetchStreamSource = new FetchStreamSource();

		const fetchRequestStopWatch = new StopWatch();

		let responseSoFar = '';

		let chatResponseFailure: ChatFetchError | undefined;

		let ttft: number | undefined;

		const firstTokenReceived = new DeferredPromise<void>();

		telemetryBuilder.setFetchStartedAt();
		logContext.setFetchStartTime();

		// we must not await this promise because we want to stream edits as they come in
		const fetchResultPromise = endpoint.makeChatRequest(
			XtabProvider.ID,
			messages,
			async (text, _, delta) => {
				if (!firstTokenReceived.isSettled) {
					firstTokenReceived.complete();
				}
				if (ttft === undefined) {
					ttft = fetchRequestStopWatch.elapsed();
					logContext.addLog(`TTFT ${ttft} ms`);
				}

				fetchStreamSource.update(text, delta);
				responseSoFar = text;
				logContext.setResponse(responseSoFar);
				return undefined;
			},
			cancellationToken,
			ChatLocation.Other,
			undefined,
			{
				temperature: 0,
				// max_tokens: 256, // `max_tokens` is not supported along with `prediction` - https://platform.openai.com/docs/guides/predicted-outputs#limitations
				stream: true,
				prediction,
			} satisfies OptionalChatRequestParams,
			undefined,
			{
				requestId: request.id,
			}
		);

		telemetryBuilder.setResponse(fetchResultPromise.then((response) => ({ response, ttft })));
		logContext.setFullResponse(fetchResultPromise.then((response) => response.type === ChatFetchResponseType.Success ? response.value : undefined));

		const fetchRes = await Promise.race([firstTokenReceived.p, fetchResultPromise]);
		if (fetchRes && fetchRes.type !== ChatFetchResponseType.Success) {
			if (fetchRes.type === ChatFetchResponseType.NotFound &&
				!this.forceUseDefaultModel // if we haven't already forced using the default model; otherwise, this could cause an infinite loop
			) {
				this.forceUseDefaultModel = true;
				return this.doGetNextEdit(request, pushEdit, delaySession, logContext, cancellationToken, telemetryBuilder, opts.retryState); // use the same retry state
			}
			pushEdit(Result.error(XtabProvider.mapChatFetcherErrorToNoNextEditReason(fetchRes)));
			return;
		}

		fetchResultPromise
			.then((response) => {
				// this's a way to signal the edit-pushing code to know if the request failed and
				// 	it shouldn't push edits constructed from an erroneous response
				chatResponseFailure = response.type !== ChatFetchResponseType.Success ? response : undefined;
			})
			.catch((err: unknown) => {
				// in principle this shouldn't happen because ChatMLFetcher's fetchOne should not throw
				logContext.setError(errors.fromUnknown(err));
				logContext.addLog(`ChatMLFetcher fetch call threw -- this's UNEXPECTED!`);

				// Properly handle the error by pushing it as a result
				pushEdit(Result.error(new NoNextEditReason.Unexpected(errors.fromUnknown(err))));
			}).finally(() => {
				logContext.setFetchEndTime();

				if (!firstTokenReceived.isSettled) {
					firstTokenReceived.complete();
				}

				fetchStreamSource.resolve();

				logContext.setResponse(responseSoFar);
			});

		const llmLinesStream = toLines(fetchStreamSource.stream);

		// logging of times
		// removal of cursor tag if option is set
		const linesStream = (() => {
			let i = 0;
			return llmLinesStream.map((v) => {

				const trace = `Line ${i++} emitted with latency ${fetchRequestStopWatch.elapsed()} ms`;
				logContext.addLog(trace);
				tracer.trace(trace);

				return opts.shouldRemoveCursorTagFromResponse
					? v.replaceAll(CURSOR_TAG, '')
					: v;
			});
		})();

		let cleanedLinesStream: AsyncIterableObject<string>;

		if (opts.promptingStrategy === xtabPromptOptions.PromptingStrategy.Xtab275) {
			cleanedLinesStream = linesStream;
		} else if (
			opts.promptingStrategy === xtabPromptOptions.PromptingStrategy.UnifiedModel ||
			opts.promptingStrategy === xtabPromptOptions.PromptingStrategy.Codexv21NesUnified ||
			opts.promptingStrategy === xtabPromptOptions.PromptingStrategy.Nes41Miniv3
		) {
			const linesIter = linesStream[Symbol.asyncIterator]();
			const firstLine = await linesIter.next();

			if (chatResponseFailure !== undefined) { // handle fetch failure
				pushEdit(Result.error(new NoNextEditReason.Unexpected(errors.fromUnknown(chatResponseFailure))));
				return;
			}

			if (firstLine.done) { // no lines in response -- unexpected case but take as no suggestions
				pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, editWindow)));
				return;
			}

			const trimmedLines = firstLine.value.trim();

			if (trimmedLines === ResponseTags.NO_CHANGE.start) {
				this.pushNoSuggestionsOrRetry(request, editWindow, pushEdit, delaySession, logContext, cancellationToken, telemetryBuilder, opts.retryState);
				return;
			}

			if (trimmedLines === ResponseTags.INSERT.start) {
				const lineWithCursorContinued = await linesIter.next();
				if (lineWithCursorContinued.done || lineWithCursorContinued.value.includes(ResponseTags.INSERT.end)) {
					pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, editWindow)));
					return;
				}
				const edit = new LineReplacement(
					new LineRange(editWindowLineRange.start + cursorOriginalLinesOffset + 1 /* 0-based to 1-based */, editWindowLineRange.start + cursorOriginalLinesOffset + 2),
					[editWindowLines[cursorOriginalLinesOffset].slice(0, cursorLineOffset - 1) + lineWithCursorContinued.value + editWindowLines[cursorOriginalLinesOffset].slice(cursorLineOffset - 1)]
				);
				pushEdit(Result.ok({ edit, window: editWindow }));

				const lines: string[] = [];
				let v = await linesIter.next();
				while (!v.done) {
					if (v.value.includes(ResponseTags.INSERT.end)) {
						break;
					} else {
						lines.push(v.value);
					}
					v = await linesIter.next();
				}

				const line = editWindowLineRange.start + cursorOriginalLinesOffset + 2;
				pushEdit(Result.ok({
					edit: new LineReplacement(
						new LineRange(line, line),
						lines
					),
					window: editWindow
				}));

				pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, editWindow)));
				return;
			}

			if (trimmedLines === ResponseTags.EDIT.start) {
				cleanedLinesStream = new AsyncIterableObject(async (emitter) => {
					let v = await linesIter.next();
					while (!v.done) {
						if (v.value.includes(ResponseTags.EDIT.end)) {
							return;
						}
						emitter.emitOne(v.value);
						v = await linesIter.next();
					}
				});
			} else {
				pushEdit(Result.error(new NoNextEditReason.Unexpected(new Error(`unexpected tag ${trimmedLines}`))));
				return;
			}
		} else {
			cleanedLinesStream = linesWithBackticksRemoved(linesStream);
		}

		const diffOptions: ResponseProcessor.DiffParams = {
			emitFastCursorLineChange: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderEmitFastCursorLineChange, this.expService),
			nLinesToConverge: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabNNonSignificantLinesToConverge, this.expService),
			nSignificantLinesToConverge: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabNSignificantLinesToConverge, this.expService),
		};

		(async () => {
			let i = 0;
			let hasBeenDelayed = false;
			try {
				for await (const edit of ResponseProcessor.diff(editWindowLines, cleanedLinesStream, cursorOriginalLinesOffset, diffOptions)) {

					const singleLineEdits: LineReplacement[] = [];
					if (edit.lineRange.startLineNumber === edit.lineRange.endLineNumberExclusive || // we don't want to run diff on insertion
						edit.newLines.length === 0 || // we don't want to run diff on deletion
						edit.lineRange.endLineNumberExclusive - edit.lineRange.startLineNumber === 1 && edit.newLines.length === 1 // we want to run diff on single line edits
					) {
						const singleLineEdit = new LineReplacement(new LineRange(edit.lineRange.startLineNumber + editWindowLineRange.start, edit.lineRange.endLineNumberExclusive + editWindowLineRange.start), edit.newLines);
						singleLineEdits.push(singleLineEdit);
					} else {
						const affectedOriginalLines = editWindowLines.slice(edit.lineRange.startLineNumber - 1, edit.lineRange.endLineNumberExclusive - 1).join('\n');

						const diffResult = await this.diffService.computeDiff(affectedOriginalLines, edit.newLines.join('\n'), {
							ignoreTrimWhitespace: false,
							maxComputationTimeMs: 0,
							computeMoves: false
						});

						const translateByNLines = editWindowLineRange.start + edit.lineRange.startLineNumber;
						for (const change of diffResult.changes) {
							const singleLineEdit = new LineReplacement(
								new LineRange(
									translateByNLines + change.original.startLineNumber - 1,
									translateByNLines + change.original.endLineNumberExclusive - 1
								),
								edit.newLines.slice(change.modified.startLineNumber - 1, change.modified.endLineNumberExclusive - 1)
							);
							singleLineEdits.push(singleLineEdit);
						}
					}

					if (chatResponseFailure) { // do not emit edits if chat response failed
						break;
					}

					logContext.setResponse(responseSoFar);

					for (const singleLineEdit of singleLineEdits) {
						const lineEdit = new LineEdit([singleLineEdit]);

						if (editWouldDeleteWhatWasJustInserted(request.getActiveDocument(), lineEdit)) {
							this.trace(`filtering edit because it would undo previous insertion: ${singleLineEdit.toString()}`, logContext, tracer);
							i++;
							continue;
						}

						this.trace(`pushing edit #${i}:\n${singleLineEdit.toString()}`, logContext, tracer);

						if (!hasBeenDelayed) { // delay only the first one
							hasBeenDelayed = true;
							await this.enforceArtificialDelay(delaySession, telemetryBuilder);
						}

						pushEdit(Result.ok({ edit: singleLineEdit, window: editWindow }));
						i++;
					}
				}

				if (chatResponseFailure) {
					pushEdit(Result.error(XtabProvider.mapChatFetcherErrorToNoNextEditReason(chatResponseFailure)));
					return;
				}

				const hadEdits = i > 0;
				if (hadEdits) {
					pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, editWindow)));
				} else {
					this.pushNoSuggestionsOrRetry(request, editWindow, pushEdit, delaySession, logContext, cancellationToken, telemetryBuilder, opts.retryState);
				}

			} catch (err) {
				logContext.setError(err);
				// Properly handle the error by pushing it as a result
				pushEdit(Result.error(new NoNextEditReason.Unexpected(errors.fromUnknown(err))));
			}
		})();
	}

	private pushNoSuggestionsOrRetry(
		request: StatelessNextEditRequest,
		editWindow: OffsetRange,
		pushEdit: PushEdit,
		delaySession: DelaySession,
		logContext: InlineEditRequestLogContext,
		cancellationToken: CancellationToken,
		telemetryBuilder: StatelessNextEditTelemetryBuilder,
		retryState: RetryState,
	) {
		const allowRetryWithExpandedWindow = this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderRetryWithNMoreLinesBelow, this.expService);

		// if allowed to retry and not retrying already, flip the retry state and try again
		if (allowRetryWithExpandedWindow && retryState === RetryState.NotRetrying) {
			this.doGetNextEdit(request, pushEdit, delaySession, logContext, cancellationToken, telemetryBuilder, RetryState.RetryingWithExpandedWindow);
			return;
		}

		pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, editWindow)));
		return;
	}

	private computeAreaAroundEditWindowLinesRange(currentDocLines: string[], cursorLine: number): OffsetRange {
		const areaAroundStart = Math.max(0, cursorLine - N_LINES_AS_CONTEXT);
		const areaAroundEndExcl = Math.min(currentDocLines.length, cursorLine + N_LINES_AS_CONTEXT + 1);

		return new OffsetRange(areaAroundStart, areaAroundEndExcl);
	}

	private computeEditWindowLinesRange(currentDocLines: string[], cursorLine: number, retryState: RetryState): OffsetRange {
		let nLinesAbove: number;
		{
			const useVaryingLinesAbove = this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderUseVaryingLinesAbove, this.expService);

			if (useVaryingLinesAbove) {
				nLinesAbove = 0; // default

				for (let i = 0; i < 8; ++i) {
					const lineIdx = cursorLine - i;
					if (lineIdx < 0) {
						break;
					}
					if (currentDocLines[lineIdx].trim() !== '') {
						nLinesAbove = i;
						break;
					}
				}
			} else {
				nLinesAbove = (this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderNLinesAbove, this.expService)
					?? N_LINES_ABOVE);
			}
		}

		let nLinesBelow = (this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderNLinesBelow, this.expService)
			?? N_LINES_BELOW);

		if (retryState === RetryState.RetryingWithExpandedWindow) {
			nLinesBelow += this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderRetryWithNMoreLinesBelow, this.expService) ?? 0;
		}

		const codeToEditStart = Math.max(0, cursorLine - nLinesAbove);
		const codeToEditEndExcl = Math.min(currentDocLines.length, cursorLine + nLinesBelow + 1);

		return new OffsetRange(codeToEditStart, codeToEditEndExcl);
	}


	public static getBacktickSection(text: string): string {
		const textTrimmedStart = text.replace(/^\`\`\`[a-zA-Z]*\r?\n/, '');
		const textTrimmedEnd = textTrimmedStart.replace(/(\r?\n)\`\`\`$/, '');
		return textTrimmedEnd;
	}

	private static mapChatFetcherErrorToNoNextEditReason(fetchError: ChatFetchError): NoNextEditReason {
		switch (fetchError.type) {
			case ChatFetchResponseType.Canceled:
				return new NoNextEditReason.GotCancelled('afterFetchCall');
			case ChatFetchResponseType.OffTopic:
			case ChatFetchResponseType.Filtered:
			case ChatFetchResponseType.PromptFiltered:
			case ChatFetchResponseType.Length:
			case ChatFetchResponseType.RateLimited:
			case ChatFetchResponseType.QuotaExceeded:
			case ChatFetchResponseType.ExtensionBlocked:
			case ChatFetchResponseType.AgentUnauthorized:
			case ChatFetchResponseType.AgentFailedDependency:
				return new NoNextEditReason.Uncategorized(errors.fromUnknown(fetchError));
			case ChatFetchResponseType.BadRequest:
			case ChatFetchResponseType.NotFound:
			case ChatFetchResponseType.Failed:
			case ChatFetchResponseType.Unknown:
				return new NoNextEditReason.FetchFailure(errors.fromUnknown(fetchError));
		}
	}

	private determinePromptingStrategy({ isXtabUnifiedModel, isCodexV21NesUnified, useSimplifiedPrompt, useXtab275Prompting, useNes41Miniv3Prompting }: { isXtabUnifiedModel: boolean; isCodexV21NesUnified: boolean; useSimplifiedPrompt: boolean; useXtab275Prompting: boolean; useNes41Miniv3Prompting: boolean }): xtabPromptOptions.PromptingStrategy | undefined {
		if (isXtabUnifiedModel) {
			return xtabPromptOptions.PromptingStrategy.UnifiedModel;
		} else if (isCodexV21NesUnified) {
			return xtabPromptOptions.PromptingStrategy.Codexv21NesUnified;
		} else if (useSimplifiedPrompt) {
			return xtabPromptOptions.PromptingStrategy.SimplifiedSystemPrompt;
		} else if (useXtab275Prompting) {
			return xtabPromptOptions.PromptingStrategy.Xtab275;
		} else if (useNes41Miniv3Prompting) {
			return xtabPromptOptions.PromptingStrategy.Nes41Miniv3;
		} else {
			return undefined;
		}
	}

	private pickSystemPrompt(promptingStrategy: xtabPromptOptions.PromptingStrategy | undefined): string {
		switch (promptingStrategy) {
			case xtabPromptOptions.PromptingStrategy.UnifiedModel:
				return unifiedModelSystemPrompt;
			case xtabPromptOptions.PromptingStrategy.Codexv21NesUnified:
			case xtabPromptOptions.PromptingStrategy.SimplifiedSystemPrompt:
				return simplifiedPrompt;
			case xtabPromptOptions.PromptingStrategy.Xtab275:
				return xtab275SystemPrompt;
			case xtabPromptOptions.PromptingStrategy.Nes41Miniv3:
				return nes41Miniv3SystemPrompt;
			default:
				return systemPromptTemplate;
		}
	}

	private getEndpoint() {
		const url = this.configService.getConfig(ConfigKey.Internal.InlineEditsXtabProviderUrl);
		const apiKey = this.configService.getConfig(ConfigKey.Internal.InlineEditsXtabProviderApiKey);
		const hasOverriddenUrlAndApiKey = url !== undefined && apiKey !== undefined;

		if (hasOverriddenUrlAndApiKey) {
			return this.instaService.createInstance(XtabEndpoint, url, apiKey);
		}

		const modelName = this.forceUseDefaultModel
			? undefined
			: this.configService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabProviderModelName, this.expService);

		return createProxyXtabEndpoint(this.instaService, modelName);
	}

	private getPredictedOutput(editWindowLines: string[], promptingStrategy: xtabPromptOptions.PromptingStrategy | undefined): Prediction | undefined {
		return this.configService.getConfig(ConfigKey.Internal.InlineEditsXtabProviderUsePrediction)
			? {
				type: 'content',
				content: XtabProvider.getPredictionContents(editWindowLines, promptingStrategy)
			}
			: undefined;
	}

	private static getPredictionContents(editWindowLines: readonly string[], promptingStrategy: xtabPromptOptions.PromptingStrategy | undefined): string {
		if (promptingStrategy === xtabPromptOptions.PromptingStrategy.UnifiedModel ||
			promptingStrategy === xtabPromptOptions.PromptingStrategy.Codexv21NesUnified ||
			promptingStrategy === xtabPromptOptions.PromptingStrategy.Nes41Miniv3
		) {
			return ['<EDIT>', ...editWindowLines, '</EDIT>'].join('\n');
		} else if (promptingStrategy === xtabPromptOptions.PromptingStrategy.Xtab275) {
			return editWindowLines.join('\n');
		} else {
			return ['```', ...editWindowLines, '```'].join('\n');
		}
	}

	private async debounce(delaySession: DelaySession, telemetry: StatelessNextEditTelemetryBuilder) {
		if (this.simulationCtx.isInSimulationTests) {
			return;
		}
		const debounceTime = delaySession.getDebounceTime();

		this.tracer.trace(`Debouncing for ${debounceTime} ms`);
		telemetry.setDebounceTime(debounceTime);

		await timeout(debounceTime);
	}

	private async enforceArtificialDelay(delaySession: DelaySession, telemetry: StatelessNextEditTelemetryBuilder) {
		if (this.simulationCtx.isInSimulationTests) {
			return;
		}
		const artificialDelay = delaySession.getArtificialDelay();

		this.tracer.trace(`Enforcing artificial delay of ${artificialDelay} ms`);
		telemetry.setArtificialDelay(artificialDelay);

		if (artificialDelay > 0) {
			await timeout(artificialDelay);
		}
	}

	private trace(msg: string, logContext: InlineEditRequestLogContext, tracer: ITracer) {
		tracer.trace(msg);
		logContext.addLog(msg);
	}
}
