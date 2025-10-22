/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createSha256Hash } from '../../../../../../util/common/crypto';
import { generateUuid } from '../../../../../../util/vs/base/common/uuid';
import { isSupportedLanguageId } from '../../../prompt/src/parse';
import { initializeTokenizers } from '../../../prompt/src/tokenization';
import { CancellationTokenSource, CancellationToken as ICancellationToken } from '../../../types/src';
import { CompletionNotifier } from '../completionNotifier';
import { CompletionState } from '../completionState';
import { BlockMode, ConfigKey, getConfig, shouldDoServerTrimming } from '../config';
import { Context } from '../context';
import { UserErrorNotifier } from '../error/userErrorNotifier';
import { Features } from '../experiments/features';
import { Logger } from '../logger';
import { isAbortError } from '../networking';
import { EngineRequestInfo, getEngineRequestInfo } from '../openai/config';
import {
	CompletionHeaders,
	CompletionRequestExtra,
	CopilotUiKind,
	FinishedCallback,
	OpenAIFetcher,
	PostOptions,
} from '../openai/fetch';
import { APIChoice, getTemperatureForSamples } from '../openai/openai';
import { CopilotNamedAnnotationList } from '../openai/stream';
import { StatusReporter } from '../progress';
import { ContextProviderBridge } from '../prompt/components/contextProviderBridge';
import {
	ContextIndentation,
	contextIndentation,
	isEmptyBlockStartUtil,
	parsingBlockFinished,
} from '../prompt/parseBlock';
import { ExtractPromptOptions, Prompt, PromptResponsePresent, extractPrompt, trimLastLine } from '../prompt/prompt';
import { ComputationStatus, MaybeRepoInfo, extractRepoInfoInBackground } from '../prompt/repository';
import { checkSuffix, postProcessChoiceInContext } from '../suggestions/suggestions';
import {
	TelemetryData,
	TelemetryMeasurements,
	TelemetryProperties,
	TelemetryWithExp,
	now,
	telemetrizePromptLength,
	telemetry,
} from '../telemetry';
import { isRunningInTest, shouldFailForDebugPurposes } from '../testing/runtimeMode';
import { IPosition, LocationFactory, TextDocumentContents } from '../textDocument';
import { delay } from '../util/async';
import { AsyncCompletionManager } from './asyncCompletions';
import { BlockPositionType, BlockTrimmer, getBlockPositionType } from './blockTrimmer';
import { CompletionsCache } from './completionsCache';
import { BlockModeConfig } from './configBlockMode';
import { CurrentGhostText } from './current';
import { requestMultilineScore } from './multilineModel';
import { StreamedCompletionSplitter } from './streamedCompletionSplitter';
import {
	GhostTextResultWithTelemetry,
	mkBasicResultTelemetry,
	mkCanceledResultTelemetry,
	resultTypeToString,
} from './telemetry';

const ghostTextLogger = new Logger('ghostText');

export interface GhostCompletion {
	completionIndex: number;
	completionText: string;
	displayText: string;
	displayNeedsWsOffset: boolean;
}

export interface CompletionResult {
	completion: GhostCompletion;
	telemetry: TelemetryWithExp;
	isMiddleOfTheLine: boolean;
	suffixCoverage: number;
	copilotAnnotations?: CopilotNamedAnnotationList;
	clientCompletionId: string;
}

export enum ResultType {
	Network,
	Cache,
	TypingAsSuggested,
	Cycling,
	Async,
}

// p50 line length is 19 characters (p95 is 73)
// average token length is around 4 characters
// the below values have quite a bit of buffer while bringing the limit in significantly from 500
const maxSinglelineTokens = 20;

async function genericGetCompletionsFromNetwork<T>(
	ctx: Context,
	requestContext: RequestContext,
	baseTelemetryData: TelemetryWithExp,
	cancellationToken: ICancellationToken | undefined,
	finishedCb: FinishedCallback,
	what: string,
	processChoices: (
		requestStart: number,
		processingTime: number,
		choicesStream: AsyncIterable<APIChoice>
	) => Promise<GhostTextResultWithTelemetry<T>>
): Promise<GhostTextResultWithTelemetry<T>> {
	ghostTextLogger.debug(ctx, `Getting ${what} from network`);

	// copy the base telemetry data
	baseTelemetryData = baseTelemetryData.extendedBy();

	// Request one choice for automatic requests, three for invoked (cycling) requests.
	const n = requestContext.isCycling ? 3 : 1;
	const temperature = getTemperatureForSamples(ctx, n);
	const extra: CompletionRequestExtra = {
		language: requestContext.languageId,
		next_indent: requestContext.indentation.next ?? 0,
		trim_by_indentation: shouldDoServerTrimming(requestContext.blockMode),
		prompt_tokens: requestContext.prompt.prefixTokens ?? 0,
		suffix_tokens: requestContext.prompt.suffixTokens ?? 0,
	};
	const postOptions: PostOptions = { n, temperature, code_annotations: false };
	const modelTerminatesSingleline =
		ctx.get(Features).modelAlwaysTerminatesSingleline(baseTelemetryData);
	const simulateSingleline =
		requestContext.blockMode === BlockMode.MoreMultiline &&
		BlockTrimmer.isSupported(requestContext.languageId) &&
		!modelTerminatesSingleline;
	if (!requestContext.multiline && !simulateSingleline) {
		// If we are not in multiline mode, we get the server to truncate the results. This does mean that we
		// also cache a single line result which will be reused even if we are later in multiline mode. This is
		// an acceptable trade-off as the transition should be relatively rare and truncating on the server is
		// more efficient.
		// Note that this also means we don't need to truncate when creating the GhostAPIChoice object below.
		postOptions['stop'] = ['\n'];
	} else if (requestContext.stop) {
		postOptions['stop'] = requestContext.stop;
	}
	if (requestContext.maxTokens !== undefined) {
		postOptions['max_tokens'] = requestContext.maxTokens;
	}

	const requestStart = Date.now();

	// extend telemetry data
	const newProperties: { [key: string]: string } = {
		endpoint: 'completions',
		uiKind: CopilotUiKind.GhostText,
		temperature: JSON.stringify(temperature),
		n: JSON.stringify(n),
		stop: JSON.stringify(postOptions['stop']) ?? 'unset',
		logit_bias: JSON.stringify(null),
	};

	Object.assign(baseTelemetryData.properties, newProperties);

	try {
		const completionParams = {
			prompt: requestContext.prompt,
			languageId: requestContext.languageId,
			repoInfo: requestContext.repoInfo,
			ourRequestId: requestContext.ourRequestId,
			engineModelId: requestContext.engineModelId,
			count: n,
			uiKind: CopilotUiKind.GhostText,
			postOptions,
			headers: requestContext.headers,
			extra,
		};
		const res = await ctx
			.get(OpenAIFetcher)
			.fetchAndStreamCompletions(ctx, completionParams, baseTelemetryData, finishedCb, cancellationToken);
		if (res.type === 'failed') {
			return {
				type: 'failed',
				reason: res.reason,
				telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
			};
		}

		if (res.type === 'canceled') {
			ghostTextLogger.debug(ctx, 'Cancelled after awaiting fetchCompletions');
			return {
				type: 'canceled',
				reason: res.reason,
				telemetryData: mkCanceledResultTelemetry(baseTelemetryData),
			};
		}

		return processChoices(requestStart, res.getProcessingTime(), res.choices);
	} catch (err) {
		// If we cancelled a network request, we don't want to log an error
		if (isAbortError(err)) {
			return {
				type: 'canceled',
				reason: 'network request aborted',
				telemetryData: mkCanceledResultTelemetry(baseTelemetryData, {
					cancelledNetworkRequest: true,
				}),
			};
		} else {
			ghostTextLogger.exception(ctx, err, `Error on ghost text request`);
			ctx.get(UserErrorNotifier).notifyUser(ctx, err);
			if (shouldFailForDebugPurposes(ctx)) {
				throw err;
			}
			// not including err in this result because it'll end up in standard telemetry
			return {
				type: 'failed',
				reason: 'non-abort error on ghost text request',
				telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
			};
		}
	}
}

/**
 * Post-proceses a completion choice based on the current request context and existing choices.
 */
function postProcessChoices(
	newChoice: APIChoice,
	requestContext: RequestContext,
	currentChoices?: APIChoice[]
): APIChoice | undefined {
	if (!currentChoices) { currentChoices = []; }
	newChoice.completionText = newChoice.completionText.trimEnd();
	if (!newChoice.completionText) { return undefined; }
	// Collect only unique displayTexts
	if (currentChoices.findIndex(v => v.completionText.trim() === newChoice.completionText.trim()) !== -1) {
		return undefined;
	}
	return newChoice;
}

export type GetNetworkCompletionsType = GhostTextResultWithTelemetry<[APIChoice, Promise<void>]>;

/** Requests new completion from OpenAI, should be called if and only if the completions for given prompt were not cached before.
 *  It returns only first completion, additional completions are added to the caches in the background.
 *  Copies from the base telemetry data are used as the basis for each choice's telemetry.
 */
async function getCompletionsFromNetwork(
	ctx: Context,
	requestContext: RequestContext,
	baseTelemetryData: TelemetryWithExp,
	cancellationToken: ICancellationToken | undefined,
	finishedCb: FinishedCallback
): Promise<GetNetworkCompletionsType> {
	return genericGetCompletionsFromNetwork(
		ctx,
		requestContext,
		baseTelemetryData,
		cancellationToken,
		finishedCb,
		'completions',
		async (requestStart, processingTime, choicesStream): Promise<GetNetworkCompletionsType> => {
			const choicesIterator = choicesStream[Symbol.asyncIterator]();

			const firstRes = await choicesIterator.next();

			if (firstRes.done) {
				ghostTextLogger.debug(ctx, 'All choices redacted');
				return {
					type: 'empty',
					reason: 'all choices redacted',
					telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
				};
			}
			if (cancellationToken?.isCancellationRequested) {
				ghostTextLogger.debug(ctx, 'Cancelled after awaiting redactedChoices iterator');
				return {
					type: 'canceled',
					reason: 'after awaiting redactedChoices iterator',
					telemetryData: mkCanceledResultTelemetry(baseTelemetryData),
				};
			}

			const firstChoice: APIChoice = firstRes.value;

			if (firstChoice === undefined) {
				// This is probably unreachable given the firstRes.done check above
				ghostTextLogger.debug(ctx, 'Got undefined choice from redactedChoices iterator');
				return {
					type: 'empty',
					reason: 'got undefined choice from redactedChoices iterator',
					telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
				};
			}

			telemetryPerformance(ctx, 'performance', firstChoice, requestStart, processingTime);

			ghostTextLogger.debug(ctx, `Awaited first result, id:  ${firstChoice.choiceIndex}`);
			// Adds first result to cache
			const processedFirstChoice = postProcessChoices(firstChoice, requestContext);
			if (processedFirstChoice) {
				appendToCache(ctx, requestContext, processedFirstChoice);
				ghostTextLogger.debug(
					ctx,
					`GhostText first completion (index ${processedFirstChoice?.choiceIndex}): ${JSON.stringify(processedFirstChoice?.completionText)}`
				);
			}
			//Create promise for each result, don't `await` it (unless in test mode) but handle asynchronously with `.then()`
			const cacheDone = (async () => {
				const apiChoices: APIChoice[] = processedFirstChoice !== undefined ? [processedFirstChoice] : [];
				for await (const choice of choicesStream) {
					if (choice === undefined) { continue; }
					ghostTextLogger.debug(
						ctx,
						`GhostText later completion (index ${choice?.choiceIndex}): ${JSON.stringify(choice.completionText)}`
					);
					const processedChoice = postProcessChoices(choice, requestContext, apiChoices);
					if (!processedChoice) { continue; }
					apiChoices.push(processedChoice);
					appendToCache(ctx, requestContext, processedChoice);
				}
			})();
			if (isRunningInTest(ctx)) {
				await cacheDone;
			}
			if (processedFirstChoice) {
				// Because we ask the server to stop at \n above, we don't need to force single line here
				return {
					type: 'success',
					value: [makeGhostAPIChoice(processedFirstChoice, { forceSingleLine: false }), cacheDone],
					telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
					telemetryBlob: baseTelemetryData,
					resultType: ResultType.Network,
				};
			} else {
				return {
					type: 'empty',
					reason: 'got undefined processedFirstChoice',
					telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
				};
			}
		}
	);
}

type GetAllNetworkCompletionsType = GhostTextResultWithTelemetry<[APIChoice[], Promise<void>]>;

/** Requests new completion from OpenAI, should be called if and only if we are in the servers-side termination mode, and it's follow-up cycling request
 *  It returns all requested completions
 *  Copies from the base telemetry data are used as the basis for each choice's telemetry.
 */
async function getAllCompletionsFromNetwork(
	ctx: Context,
	requestContext: RequestContext,
	baseTelemetryData: TelemetryWithExp,
	cancellationToken: ICancellationToken | undefined,
	finishedCb: FinishedCallback
): Promise<GetAllNetworkCompletionsType> {
	return genericGetCompletionsFromNetwork(
		ctx,
		requestContext,
		baseTelemetryData,
		cancellationToken,
		finishedCb,
		'all completions',
		async (requestStart, processingTime, choicesStream): Promise<GetAllNetworkCompletionsType> => {
			const apiChoices: APIChoice[] = [];
			for await (const choice of choicesStream) {
				if (cancellationToken?.isCancellationRequested) {
					ghostTextLogger.debug(ctx, 'Cancelled after awaiting choices iterator');
					return {
						type: 'canceled',
						reason: 'after awaiting choices iterator',
						telemetryData: mkCanceledResultTelemetry(baseTelemetryData),
					};
				}
				const processedChoice = postProcessChoices(choice, requestContext, apiChoices);
				if (!processedChoice) { continue; }
				apiChoices.push(processedChoice);
			}
			//Append results to current completions cache, and network cache
			if (apiChoices.length > 0) {
				for (const choice of apiChoices) {
					appendToCache(ctx, requestContext, choice);
				}

				telemetryPerformance(ctx, 'cyclingPerformance', apiChoices[0], requestStart, processingTime);
			}
			return {
				type: 'success',
				value: [apiChoices, Promise.resolve()],
				telemetryData: mkBasicResultTelemetry(baseTelemetryData, ctx),
				telemetryBlob: baseTelemetryData,
				resultType: ResultType.Cycling,
			};
		}
	);
}

function makeGhostAPIChoice(choice: APIChoice, options: { forceSingleLine: boolean }): APIChoice {
	const ghostChoice = { ...choice } as APIChoice;
	if (options.forceSingleLine) {
		const { completionText } = ghostChoice;
		// Special case for when completion starts with a newline, don't count that as its own line
		const initialLineBreak = completionText.match(/^\r?\n/);
		if (initialLineBreak) {
			ghostChoice.completionText = initialLineBreak[0] + completionText.split('\n')[1];
		} else {
			ghostChoice.completionText = completionText.split('\n')[0];
		}
	}
	return ghostChoice;
}

type GhostTextStrategy = {
	blockMode: BlockMode;
	requestMultiline: boolean;
	finishedCb: FinishedCallback;
	stop?: string[];
	maxTokens?: number;
};

function takeNLines(n: number): FinishedCallback {
	return (text: string): number | undefined => {
		// If the text is longer than n lines, return the offset.
		// Checks for n+1 lines because of the leading newline.
		const lines = text?.split('\n') ?? [];
		if (lines.length > n + 1) {
			return lines.slice(0, n + 1).join('\n').length;
		}
	};
}

async function getGhostTextStrategy(
	ctx: Context,
	completionState: CompletionState,
	prefix: string,
	prompt: PromptResponsePresent,
	isCycling: boolean,
	inlineSuggestion: boolean,
	hasAcceptedCurrentCompletion: boolean,
	preIssuedTelemetryData: TelemetryWithExp
): Promise<GhostTextStrategy> {
	const multilineAfterAcceptLines = ctx.get(Features).multilineAfterAcceptLines(preIssuedTelemetryData);
	const blockMode = ctx
		.get(BlockModeConfig)
		.forLanguage(ctx, completionState.textDocument.detectedLanguageId, preIssuedTelemetryData);
	switch (blockMode) {
		case BlockMode.Server:
			// Override the server-side trimming after accepting a completion
			if (hasAcceptedCurrentCompletion) {
				return {
					blockMode: BlockMode.Parsing,
					requestMultiline: true,
					finishedCb: takeNLines(multilineAfterAcceptLines),
					stop: ['\n\n'],
					maxTokens: maxSinglelineTokens * multilineAfterAcceptLines,
				};
			}
			return {
				blockMode: BlockMode.Server,
				requestMultiline: true,
				finishedCb: _ => undefined,
			};
		case BlockMode.Parsing:
		case BlockMode.ParsingAndServer:
		case BlockMode.MoreMultiline:
		default: {
			// we shouldn't drop through to here, but in case we do, be explicit about the behaviour
			let requestMultiline: MultilineDetermination;
			try {
				requestMultiline = await shouldRequestMultiline(
					ctx,
					blockMode,
					completionState.textDocument,
					completionState.position,
					inlineSuggestion,
					hasAcceptedCurrentCompletion,
					prompt
				);
			} catch (err) {
				// Fallback to non-multiline
				requestMultiline = { requestMultiline: false };
			}
			if (
				!hasAcceptedCurrentCompletion &&
				requestMultiline.requestMultiline &&
				ctx.get(Features).singleLineUnlessAccepted(preIssuedTelemetryData)
			) {
				requestMultiline.requestMultiline = false;
			}
			if (requestMultiline.requestMultiline) {
				// Note that `trailingWs` contains *any* trailing whitespace from the prompt, but the prompt itself
				// is only trimmed if the entire last line is whitespace.  We have to account for that here when we
				// check whether the block body is finished.
				let adjustedPosition;
				if (prompt.trailingWs.length > 0 && !prompt.prompt.prefix.endsWith(prompt.trailingWs)) {
					// Prompt was adjusted, so adjust the position to match
					adjustedPosition = LocationFactory.position(
						completionState.position.line,
						Math.max(completionState.position.character - prompt.trailingWs.length, 0)
					);
				} else {
					// Otherwise, just use the original position
					adjustedPosition = completionState.position;
				}
				return {
					blockMode: blockMode,
					requestMultiline: true,
					...buildFinishedCallback(
						ctx,
						blockMode,
						completionState.textDocument,
						adjustedPosition,
						requestMultiline.blockPosition,
						prefix,
						true,
						prompt.prompt,
						preIssuedTelemetryData
					),
				};
			}
			// Override single-line to multiline after accepting a completion
			if (hasAcceptedCurrentCompletion) {
				const result: GhostTextStrategy = {
					blockMode: BlockMode.Parsing,
					requestMultiline: true,
					finishedCb: takeNLines(multilineAfterAcceptLines),
					stop: ['\n\n'],
					maxTokens: maxSinglelineTokens * multilineAfterAcceptLines,
				};
				if (blockMode === BlockMode.MoreMultiline) {
					result.blockMode = BlockMode.MoreMultiline;
				}
				return result;
			}
			// not multiline
			return {
				blockMode: blockMode,
				requestMultiline: false,
				...buildFinishedCallback(
					ctx,
					blockMode,
					completionState.textDocument,
					completionState.position,
					requestMultiline.blockPosition,
					prefix,
					false,
					prompt.prompt,
					preIssuedTelemetryData
				),
			};
		}
	}
}

function buildFinishedCallback(
	ctx: Context,
	blockMode: BlockMode,
	document: TextDocumentContents,
	position: IPosition,
	positionType: BlockPositionType | undefined,
	prefix: string,
	multiline: boolean,
	prompt: Prompt,
	telemetryData: TelemetryWithExp
): { finishedCb: FinishedCallback; maxTokens?: number } {
	if (multiline && blockMode === BlockMode.MoreMultiline && BlockTrimmer.isSupported(document.detectedLanguageId)) {
		const lookAhead =
			positionType === BlockPositionType.EmptyBlock || positionType === BlockPositionType.BlockEnd
				? ctx.get(Features).longLookaheadSize(telemetryData)
				: ctx.get(Features).shortLookaheadSize(telemetryData);

		const finishedCb = new StreamedCompletionSplitter(
			ctx,
			prefix,
			document.detectedLanguageId,
			false,
			lookAhead,
			(extraPrefix: string, item: APIChoice) => {
				const cacheContext = {
					prefix: prefix + extraPrefix,
					prompt: { ...prompt, prefix: prompt.prefix + extraPrefix },
				};
				appendToCache(ctx, cacheContext, item);
			}
		).getFinishedCallback();

		return {
			finishedCb,
			maxTokens: ctx.get(Features).maxMultilineTokens(telemetryData),
		};
	}

	return { finishedCb: multiline ? parsingBlockFinished(ctx, document, position) : _ => undefined };
}

export type GetGhostTextOptions = ExtractPromptOptions & {
	/** Indicates if this is a cycling request. */
	isCycling: boolean;
	/** Whether to stop the ghost text request after computing the prompt (used in the simulator)
	 */
	promptOnly: boolean;
	/**
	 * Indicates if this is a speculative request generated assuming that the completion was accepted,
	 */
	isSpeculative: boolean;
	/**
	 * Opportunity ID is a unique ID generated by the client relating to a
	 * single "opportunity" to provide some kind of suggestion to the user.
	 */
	opportunityId?: string;
	/**
	 * An optional debounce time in milliseconds before requesting a completion.
	 * Overridable via config or exp variable: `copilotvscodedebouncethreshold`.
	 */
	debounceMs?: number;
};

const defaultOptions: GetGhostTextOptions = {
	isCycling: false,
	promptOnly: false,
	isSpeculative: false,
};

function getRemainingDebounceMs(ctx: Context, opts: GetGhostTextOptions, telemetry: TelemetryWithExp): number {
	const debounce =
		getConfig<number | undefined>(ctx, ConfigKey.CompletionsDebounce) ??
		ctx.get(Features).completionsDebounce(telemetry) ??
		opts.debounceMs;
	if (debounce === undefined) { return 0; }
	const elapsed = now() - telemetry.issuedTime;
	return Math.max(0, debounce - elapsed);
}

function inlineCompletionRequestCancelled(
	ctx: Context,
	requestId: string,
	cancellationToken?: ICancellationToken
): boolean {
	return cancellationToken?.isCancellationRequested || requestId !== ctx.get(CurrentGhostText).currentRequestId;
}

async function getGhostTextWithoutAbortHandling(
	ctx: Context,
	completionState: CompletionState,
	ourRequestId: string,
	preIssuedTelemetryDataWithExp: TelemetryWithExp,
	cancellationToken?: ICancellationToken,
	options?: Partial<GetGhostTextOptions>
): Promise<GhostTextResultWithTelemetry<[CompletionResult[], ResultType]>> {
	let start = preIssuedTelemetryDataWithExp.issuedTime; // Start before getting exp assignments
	const performanceMetrics: [string, number][] = [];
	/** Internal helper to record performance measurements. Mutates performanceMetrics and start. */
	function recordPerformance(name: string) {
		const next = now();
		performanceMetrics.push([name, next - start]);
		start = next;
	}
	recordPerformance('telemetry');
	const features = ctx.get(Features);

	if (inlineCompletionRequestCancelled(ctx, ourRequestId, cancellationToken)) {
		return {
			type: 'abortedBeforeIssued',
			reason: 'cancelled before extractPrompt',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	const inlineSuggestion = isInlineSuggestion(completionState.textDocument, completionState.position);
	if (inlineSuggestion === undefined) {
		ghostTextLogger.debug(ctx, 'Breaking, invalid middle of the line');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Invalid middle of the line',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	const engineInfo = getEngineRequestInfo(ctx, preIssuedTelemetryDataWithExp);
	const ghostTextOptions = { ...defaultOptions, ...options, tokenizer: engineInfo.tokenizer };
	const prompt = await extractPrompt(
		ctx,
		ourRequestId,
		completionState,
		preIssuedTelemetryDataWithExp,
		undefined,
		ghostTextOptions
	);
	recordPerformance('prompt');
	if (prompt.type === 'copilotContentExclusion') {
		ghostTextLogger.debug(ctx, 'Copilot not available, due to content exclusion');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Copilot not available due to content exclusion',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	if (prompt.type === 'contextTooShort') {
		ghostTextLogger.debug(ctx, 'Breaking, not enough context');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Not enough context',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	if (prompt.type === 'promptError') {
		ghostTextLogger.debug(ctx, 'Error while building the prompt');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Error while building the prompt',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	if (ghostTextOptions.promptOnly) {
		return { type: 'promptOnly', reason: 'Breaking, promptOnly set to true', prompt: prompt };
	}

	if (prompt.type === 'promptCancelled') {
		ghostTextLogger.debug(ctx, 'Cancelled during extractPrompt');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Cancelled during extractPrompt',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	if (prompt.type === 'promptTimeout') {
		ghostTextLogger.debug(ctx, 'Timeout during extractPrompt');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Timeout',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	if (prompt.prompt.prefix.length === 0 && prompt.prompt.suffix.length === 0) {
		ghostTextLogger.debug(ctx, 'Error empty prompt');
		return {
			type: 'abortedBeforeIssued',
			reason: 'Empty prompt',
			telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
		};
	}

	const debounce = getRemainingDebounceMs(ctx, ghostTextOptions, preIssuedTelemetryDataWithExp);
	if (debounce > 0) {
		ghostTextLogger.debug(ctx, `Debouncing ghost text request for ${debounce}ms`);
		await delay(debounce);
		if (inlineCompletionRequestCancelled(ctx, ourRequestId, cancellationToken)) {
			return {
				type: 'abortedBeforeIssued',
				reason: 'cancelled after debounce',
				telemetryData: mkBasicResultTelemetry(preIssuedTelemetryDataWithExp, ctx),
			};
		}
	}

	const statusBarItem = ctx.get(StatusReporter);

	return statusBarItem.withProgress(async () => {
		const [prefix] = trimLastLine(
			completionState.textDocument.getText(
				LocationFactory.range(LocationFactory.position(0, 0), completionState.position)
			)
		);

		const hasAcceptedCurrentCompletion = ctx
			.get(CurrentGhostText)
			.hasAcceptedCurrentCompletion(prefix, prompt.prompt.suffix);
		const originalPrompt = prompt.prompt;
		const ghostTextStrategy = await getGhostTextStrategy(
			ctx,
			completionState,
			prefix,
			prompt,
			ghostTextOptions.isCycling,
			inlineSuggestion,
			hasAcceptedCurrentCompletion,
			preIssuedTelemetryDataWithExp
		);
		recordPerformance('strategy');

		let choices = getLocalInlineSuggestion(ctx, prefix, originalPrompt, ghostTextStrategy.requestMultiline);
		recordPerformance('cache');
		const repoInfo = extractRepoInfoInBackground(ctx, completionState.textDocument.uri);
		const requestContext: RequestContext = {
			blockMode: ghostTextStrategy.blockMode,
			languageId: completionState.textDocument.detectedLanguageId,
			repoInfo: repoInfo,
			engineModelId: engineInfo.modelId,
			ourRequestId,
			prefix,
			prompt: prompt.prompt,
			multiline: ghostTextStrategy.requestMultiline,
			indentation: contextIndentation(completionState.textDocument, completionState.position),
			isCycling: ghostTextOptions.isCycling,
			headers: engineInfo.headers,
			stop: ghostTextStrategy.stop,
			maxTokens: ghostTextStrategy.maxTokens,
			afterAccept: hasAcceptedCurrentCompletion,
		};
		// Add headers to identify async completions and speculative requests
		requestContext.headers = {
			...requestContext.headers,
			'X-Copilot-Async': 'true',
			'X-Copilot-Speculative': ghostTextOptions.isSpeculative ? 'true' : 'false',
		};

		// this will be used as basis for the choice telemetry data
		const telemetryData = telemetryIssued(
			ctx,
			completionState.textDocument,
			requestContext,
			completionState.position,
			prompt,
			preIssuedTelemetryDataWithExp,
			engineInfo,
			ghostTextOptions
		);

		// Wait before requesting more completions if there is a candidate
		// completion request in flight. Does not wait for cycling requests or
		// if there is a cached completion.
		if (
			choices === undefined &&
			!ghostTextOptions.isCycling &&
			ctx.get(AsyncCompletionManager).shouldWaitForAsyncCompletions(prefix, prompt.prompt)
		) {
			const choice = await ctx
				.get(AsyncCompletionManager)
				.getFirstMatchingRequestWithTimeout(
					ourRequestId,
					prefix,
					prompt.prompt,
					ghostTextOptions.isSpeculative,
					telemetryData
				);
			recordPerformance('asyncWait');
			if (choice) {
				const forceSingleLine = !ghostTextStrategy.requestMultiline;
				const trimmedChoice = makeGhostAPIChoice(choice[0], { forceSingleLine });
				choices = [[trimmedChoice], ResultType.Async];
			}
			if (inlineCompletionRequestCancelled(ctx, ourRequestId, cancellationToken)) {
				ghostTextLogger.debug(ctx, 'Cancelled before requesting a new completion');
				return {
					type: 'abortedBeforeIssued',
					reason: 'Cancelled after waiting for async completion',
					telemetryData: mkBasicResultTelemetry(telemetryData, ctx),
				};
			}
		}

		const isMoreMultiline =
			ghostTextStrategy.blockMode === BlockMode.MoreMultiline &&
			BlockTrimmer.isSupported(completionState.textDocument.detectedLanguageId);
		if (choices !== undefined) {
			// Post-process any cached choices before deciding whether to issue a network request
			choices[0] = choices[0]
				.map(c =>
					postProcessChoiceInContext(
						ctx,
						completionState.textDocument,
						completionState.position,
						c,
						isMoreMultiline,
						ghostTextLogger
					)
				)
				.filter(c => c !== undefined);
		}

		if (choices !== undefined && choices[0].length === 0) {
			ghostTextLogger.debug(ctx, `Found empty inline suggestions locally via ${resultTypeToString(choices[1])}`);
			return {
				type: 'empty',
				reason: 'cached results empty after post-processing',
				telemetryData: mkBasicResultTelemetry(telemetryData, ctx),
			};
		}
		if (
			choices !== undefined &&
			choices[0].length > 0 &&
			// If it's a cycling request, need to show multiple choices
			(!ghostTextOptions.isCycling || choices[0].length > 1)
		) {
			ghostTextLogger.debug(ctx, `Found inline suggestions locally via ${resultTypeToString(choices[1])}`);
		} else {
			// No local choices, go to network
			if (ghostTextOptions.isCycling) {
				const networkChoices = await getAllCompletionsFromNetwork(
					ctx,
					requestContext,
					telemetryData,
					cancellationToken,
					ghostTextStrategy.finishedCb
				);

				// TODO: if we already had some choices cached from the initial non-cycling request,
				// and then the cycling request returns no results for some reason, we need to still
				// return the original choices to the editor to avoid the ghost text disappearing completely.
				// However this should be telemetrised according to the result of the cycling request itself,
				// i.e. failure/empty (or maybe canceled).
				//
				// Right now this is awkward to orchestrate in the code and we don't handle it, incorrectly
				// returning `ghostText.produced` instead. Cycling is a manual action and hence uncommon,
				// so this shouldn't cause much inaccuracy, but we still should fix this.
				if (networkChoices.type === 'success') {
					const resultChoices = choices?.[0] ?? [];
					networkChoices.value[0].forEach(c => {
						// Collect only unique displayTexts
						if (resultChoices.findIndex(v => v.completionText.trim() === c.completionText.trim()) !== -1) {
							return;
						}
						resultChoices.push(c);
					});
					choices = [resultChoices, ResultType.Cycling];
				} else {
					if (choices === undefined) {
						return networkChoices;
					}
				}
			} else {
				// Wrap an observer around the finished callback to update the
				// async manager as the request streams in.
				const finishedCb: FinishedCallback = (text, delta) => {
					ctx.get(AsyncCompletionManager).updateCompletion(ourRequestId, text);
					return ghostTextStrategy.finishedCb(text, delta);
				};

				const asyncCancellationTokenSource = new CancellationTokenSource();
				const requestPromise = getCompletionsFromNetwork(
					ctx,
					requestContext,
					telemetryData,
					asyncCancellationTokenSource.token,
					finishedCb
				);
				void ctx
					.get(AsyncCompletionManager)
					.queueCompletionRequest(
						ourRequestId,
						prefix,
						prompt.prompt,
						asyncCancellationTokenSource,
						requestPromise
					);
				const c = await ctx
					.get(AsyncCompletionManager)
					.getFirstMatchingRequest(ourRequestId, prefix, prompt.prompt, ghostTextOptions.isSpeculative);
				if (c === undefined) {
					return {
						type: 'empty',
						reason: 'received no results from async completions',
						telemetryData: mkBasicResultTelemetry(telemetryData, ctx),
					};
				}
				choices = [[c[0]], ResultType.Async];
			}
			recordPerformance('network');
		}
		if (choices === undefined) {
			return {
				type: 'failed',
				reason: 'internal error: choices should be defined after network call',
				telemetryData: mkBasicResultTelemetry(telemetryData, ctx),
			};
		}
		const [choicesArray, resultType] = choices;

		const postProcessedChoicesArray = choicesArray
			.map(c =>
				postProcessChoiceInContext(
					ctx,
					completionState.textDocument,
					completionState.position,
					c,
					isMoreMultiline,
					ghostTextLogger
				)
			)
			.filter(c => c !== undefined);

		// Delay response if needed. Note, this must come before the
		// telemetryWithAddData call since the time_to_produce_ms is computed
		// there
		const completionsDelay =
			getConfig<number | undefined>(ctx, ConfigKey.CompletionsDelay) ??
			features.completionsDelay(preIssuedTelemetryDataWithExp);
		const elapsed = now() - preIssuedTelemetryDataWithExp.issuedTime;
		const remainingDelay = Math.max(completionsDelay - elapsed, 0);
		if (resultType !== ResultType.TypingAsSuggested && !ghostTextOptions.isCycling && remainingDelay > 0) {
			ghostTextLogger.debug(ctx, `Waiting ${remainingDelay}ms before returning completion`);
			await delay(remainingDelay);
			if (inlineCompletionRequestCancelled(ctx, ourRequestId, cancellationToken)) {
				ghostTextLogger.debug(ctx, 'Cancelled after completions delay');
				return {
					type: 'canceled',
					reason: 'after completions delay',
					telemetryData: mkCanceledResultTelemetry(telemetryData),
				};
			}
		}

		const results: CompletionResult[] = [];
		for (const choice of postProcessedChoicesArray) {
			// Do this to get a new object for each choice
			const choiceTelemetryData = telemetryWithAddData(
				ctx,
				completionState.textDocument,
				requestContext,
				choice,
				telemetryData
			);

			const suffixCoverage = inlineSuggestion
				? checkSuffix(completionState.textDocument, completionState.position, choice)
				: 0;

			// We want to use `newTrailingWs` as the trailing whitespace
			const ghostCompletion = adjustLeadingWhitespace(
				choice.choiceIndex,
				choice.completionText,
				prompt.trailingWs
			);
			const res: CompletionResult = {
				completion: ghostCompletion,
				telemetry: choiceTelemetryData,
				isMiddleOfTheLine: inlineSuggestion,
				suffixCoverage,
				copilotAnnotations: choice.copilotAnnotations,
				clientCompletionId: choice.clientCompletionId,
			};
			results.push(res);
		}

		// Lift clientCompletionId out of the result in order to include it in the telemetry payload computed by mkBasicResultTelemetry.
		telemetryData.properties.clientCompletionId = results[0]?.clientCompletionId;
		// If reading from the cache or async, capture the look back offset used
		telemetryData.measurements.foundOffset = results?.[0]?.telemetry?.measurements?.foundOffset ?? -1;
		ghostTextLogger.debug(
			ctx,
			`Produced ${results.length} results from ${resultTypeToString(resultType)} at ${telemetryData.measurements.foundOffset} offset`
		);

		if (inlineCompletionRequestCancelled(ctx, ourRequestId, cancellationToken)) {
			return {
				type: 'canceled',
				reason: 'after post processing completions',
				telemetryData: mkCanceledResultTelemetry(telemetryData),
			};
		}

		if (!ghostTextOptions.isSpeculative) {
			// Update the current ghost text with the new response before returning for the "typing as suggested" UX
			ctx.get(CurrentGhostText).setGhostText(prefix, prompt.prompt.suffix, postProcessedChoicesArray, resultType);
		}

		recordPerformance('complete');

		return {
			type: 'success',
			value: [results, resultType],
			telemetryData: mkBasicResultTelemetry(telemetryData, ctx),
			telemetryBlob: telemetryData,
			resultType,
			performanceMetrics,
		};
	});
}

export async function getGhostText(
	ctx: Context,
	completionState: CompletionState,
	token?: ICancellationToken,
	options?: Partial<GetGhostTextOptions>
): Promise<GhostTextResultWithTelemetry<[CompletionResult[], ResultType]>> {
	const id = generateUuid();
	ctx.get(CurrentGhostText).currentRequestId = id;
	const telemetryData = await createTelemetryWithExp(ctx, completionState.textDocument, id, options);
	// A CLS consumer has an LSP bug where it erroneously makes method requests before `initialize` has returned, which
	// means we can't use `initialize` to actually initialize anything expensive.  This the primary user of the
	// tokenizer, so settle for initializing here instead.  We don't use waitForTokenizers() because in the event of a
	// tokenizer load failure, that would spam handleException() on every request.
	await initializeTokenizers.catch(() => { });
	try {
		ctx.get(ContextProviderBridge).schedule(
			completionState,
			id,
			options?.opportunityId ?? '',
			telemetryData,
			token,
			options
		);
		ctx.get(CompletionNotifier).notifyRequest(completionState, id, telemetryData, token, options);
		return await getGhostTextWithoutAbortHandling(ctx, completionState, id, telemetryData, token, options);
	} catch (e) {
		// The cancellation token may be called after the request is done but while we still process data.
		// The underlying implementation catches abort errors for specific scenarios but we still have uncovered paths.
		// To avoid returning an error to the editor, this acts as an fault barrier here.
		if (isAbortError(e)) {
			return {
				type: 'canceled',
				reason: 'aborted at unknown location',
				telemetryData: mkCanceledResultTelemetry(telemetryData, {
					cancelledNetworkRequest: true,
				}),
			};
		}
		throw e;
	}
}

/**
 * Attempt to get InlineSuggestion locally, in one of two ways:
 *  1. If the user is typing the letters already displayed as inline suggestion.
 *  2. If we have a previously cached inline suggestion for this prompt and requestMultiline.
 */
function getLocalInlineSuggestion(
	ctx: Context,
	prefix: string,
	prompt: Prompt,
	requestMultiline: boolean
): [APIChoice[], ResultType] | undefined {
	const choicesTyping = ctx.get(CurrentGhostText).getCompletionsForUserTyping(prefix, prompt.suffix);
	const choicesCache = getCompletionsFromCache(ctx, prefix, prompt.suffix, requestMultiline);

	if (choicesTyping && choicesTyping.length > 0) {
		// Append cached choices to choicesTyping, if any. Ensure typing choices
		// are first so that the shown completion doesn't disappear.
		// Filter duplicates by completionText
		const choicesCacheDeduped = (choicesCache ?? []).filter(
			c => !choicesTyping.some(t => t.completionText === c.completionText)
		);
		return [choicesTyping.concat(choicesCacheDeduped), ResultType.TypingAsSuggested];
	}

	if (choicesCache && choicesCache.length > 0) {
		return [choicesCache, ResultType.Cache];
	}
}

/** Info for caching completions. */
interface CacheContext {
	/** The text content up to the cursor. */
	prefix: string;
	/** The prompt to send to the model. */
	prompt: Prompt;
	/**
	 * If true, add an extra newline at the end of the prefix of the prompt. This is used to get a completion for the next line.
	 * Unset if the feature is disabled.
	 */
	requestForNextLine?: boolean;
}

/** Info for requesting and caching completions. */
interface RequestContext {
	/** How block trimming should be done. */
	blockMode: BlockMode;
	/** The language of the file. */
	languageId: string;
	/** Information about the repository the file is in, if available. */
	repoInfo: MaybeRepoInfo;
	/** The engine used for the request. */
	engineModelId: string;
	/** A request id we choose in the hope that the model will use it in responses */
	ourRequestId: string;
	/** The text content up to the cursor. */
	prefix: string;
	/** The prompt to send to the model. */
	prompt: Prompt;
	/** Whether this request should be able to generate multiple lines. */
	multiline: boolean;
	/** Indentation (tabs or spaces) on/before and after the cursor. */
	indentation: ContextIndentation;
	/** Follow up request happening when user requested cycling */
	isCycling: boolean;
	/** Additional request headers */
	headers: CompletionHeaders;
	/** Optional override for the default stop sequences for this request. */
	stop?: string[];
	/** Optional override for max tokens to return */
	maxTokens?: number;
	/** Whether the current request is following an accepted completion. */
	afterAccept: boolean;
}

/** Checks if the position is valid inline suggestion position. Returns `undefined` if it's position where ghost text shouldn't be displayed */
function isInlineSuggestion(document: TextDocumentContents, position: IPosition) {
	//Checks if we're in the position for the middle of the line suggestion
	const isMiddleOfLine = isMiddleOfTheLine(position, document);
	const isValidMiddleOfLine = isValidMiddleOfTheLinePosition(position, document);

	if (isMiddleOfLine && !isValidMiddleOfLine) {
		return;
	}

	const isInlineSuggestion = isMiddleOfLine && isValidMiddleOfLine;
	return isInlineSuggestion;
}

/** Checks if position is NOT at the end of the line */
function isMiddleOfTheLine(selectionPosition: IPosition, doc: TextDocumentContents): boolean {
	// must be end of line or trailing whitespace
	const line = doc.lineAt(selectionPosition);
	if (line.text.substr(selectionPosition.character).trim().length !== 0) {
		return true;
	}

	return false;
}

/** Checks if position is valid for the middle of the line suggestion */
function isValidMiddleOfTheLinePosition(selectionPosition: IPosition, doc: TextDocumentContents): boolean {
	const line = doc.lineAt(selectionPosition);
	const endOfLine = line.text.substr(selectionPosition.character).trim();
	return /^\s*[)>}\]"'`]*\s*[:{;,]?\s*$/.test(endOfLine);
}

/** Checks if position is the beginning of an empty line (including indentation) */
function isNewLine(selectionPosition: IPosition, doc: TextDocumentContents): boolean {
	const line = doc.lineAt(selectionPosition);
	const lineTrimmed = line.text.trim();
	return lineTrimmed.length === 0;
}

// This enables tests to control multi line behavior
export class ForceMultiLine {
	static readonly default = new ForceMultiLine();

	constructor(readonly requestMultilineOverride = false) { }
}

type MultilineDetermination = {
	requestMultiline: boolean;
	blockPosition?: BlockPositionType;
};

async function shouldRequestMultiline(
	ctx: Context,
	blockMode: BlockMode,
	document: TextDocumentContents,
	position: IPosition,
	inlineSuggestion: boolean,
	afterAccept: boolean,
	prompt: PromptResponsePresent
): Promise<MultilineDetermination> {
	if (ctx.get(ForceMultiLine).requestMultilineOverride) {
		return { requestMultiline: true };
	}

	// Parsing long files for multiline completions is slow, so we only do
	// it for files with less than 8000 lines
	if (document.lineCount >= 8000) {
		telemetry(
			ctx,
			'ghostText.longFileMultilineSkip',
			TelemetryData.createAndMarkAsIssued({
				languageId: document.detectedLanguageId,
				lineCount: String(document.lineCount),
				currentLine: String(position.line),
			})
		);
	} else {
		if (blockMode === BlockMode.MoreMultiline && BlockTrimmer.isSupported(document.detectedLanguageId)) {
			if (!afterAccept) {
				return { requestMultiline: false };
			}
			const blockPosition = await getBlockPositionType(document, position);
			return { requestMultiline: true, blockPosition };
		}

		const targetLanguagesNewLine = ['typescript', 'typescriptreact'];
		if (targetLanguagesNewLine.includes(document.detectedLanguageId)) {
			const newLine = isNewLine(position, document);
			if (newLine) {
				return { requestMultiline: true };
			}
		}
		let requestMultiline = false;
		if (!inlineSuggestion && isSupportedLanguageId(document.detectedLanguageId)) {
			// Can only check block-level nodes of languages we support
			requestMultiline = await isEmptyBlockStartUtil(document, position);
		} else if (inlineSuggestion && isSupportedLanguageId(document.detectedLanguageId)) {
			//If we are inline, check if we would suggest multiline for current position or if we would suggest a multiline completion if we were at the end of the line
			requestMultiline =
				(await isEmptyBlockStartUtil(document, position)) ||
				(await isEmptyBlockStartUtil(document, document.lineAt(position).range.end));
		}
		// If requestMultiline is false, for specific languages check multiline score
		if (!requestMultiline) {
			const requestMultiModelThreshold = 0.5;
			const targetLanguagesModel = ['javascript', 'javascriptreact', 'python'];
			if (targetLanguagesModel.includes(document.detectedLanguageId)) {
				// Call multiline model if not multiline and EXP flag is set.
				const multiModelScore = requestMultilineScore(prompt.prompt, document.detectedLanguageId);
				requestMultiline = multiModelScore > requestMultiModelThreshold;
			}
		}
		return { requestMultiline };
	}
	return { requestMultiline: false };
}

/** Appends completions to existing entry in cache or creates new entry. */
function appendToCache(ctx: Context, requestContext: CacheContext, choice: APIChoice) {
	ctx.get(CompletionsCache).append(requestContext.prefix, requestContext.prompt.suffix, choice);
}

function adjustLeadingWhitespace(index: number, text: string, ws: string): GhostCompletion {
	if (ws.length > 0) {
		if (text.startsWith(ws)) {
			// Remove common prefix so that it can display in the correct position
			return {
				completionIndex: index,
				completionText: text,
				displayText: text.substring(ws.length),
				displayNeedsWsOffset: false,
			};
		} else {
			// The idea here is that we do want the display to be as close to the final position as possible
			const textLeftWs = text.substring(0, text.length - text.trimStart().length);
			if (ws.startsWith(textLeftWs)) {
				// NOTE: It's possible that `ws` is a bit too over-indented. Example:
				// def foo(n):
				//     if n > 0:
				//         print(f"n is positive: {n}")
				//         [cursor is here after new line]
				//
				// completion: "    else:"
				return {
					completionIndex: index,
					completionText: text,
					displayText: text.trimStart(),
					displayNeedsWsOffset: true,
				};
			} else {
				// We don't know any better so just send `text` back
				return { completionIndex: index, completionText: text, displayText: text, displayNeedsWsOffset: false };
			}
		}
	} else {
		// If we do not know leading whitespace or if it is an empty string, just return input text
		return { completionIndex: index, completionText: text, displayText: text, displayNeedsWsOffset: false };
	}
}

/**
 * Returns all completions from the cache for given document prefix. Walks back
 * from the current prefix to search for completions with a prefix that
 * partially matches the current prefix and completion text that matches the
 * remaining current prefix.
 */
function getCompletionsFromCache(
	ctx: Context,
	prefix: string,
	suffix: string,
	multiline: boolean
): APIChoice[] | undefined {
	const choices = ctx.get(CompletionsCache).findAll(prefix, suffix);
	if (choices.length === 0) {
		ghostTextLogger.debug(ctx, `Found no completions in cache`);
		return [];
	}
	ghostTextLogger.debug(ctx, `Found ${choices.length} completions in cache`);
	return choices.map(choice => makeGhostAPIChoice(choice, { forceSingleLine: !multiline }));
}

/** Create a TelemetryWithExp instance for a ghost text request. */
async function createTelemetryWithExp(
	ctx: Context,
	document: TextDocumentContents,
	headerRequestId: string,
	options?: Partial<GetGhostTextOptions>
): Promise<TelemetryWithExp> {
	const properties: TelemetryProperties = { headerRequestId };
	if (options?.opportunityId) { properties.opportunityId = options.opportunityId; }
	if (options?.selectedCompletionInfo?.text) { properties.completionsActive = 'true'; }
	if (options?.isSpeculative) { properties.reason = 'speculative'; }
	const telemetryData = TelemetryData.createAndMarkAsIssued(properties);
	const features = ctx.get(Features);
	const telemetryWithExp = await features.updateExPValuesAndAssignments(
		{ uri: document.uri, languageId: document.detectedLanguageId },
		telemetryData
	);
	return telemetryWithExp;
}

/** Return a copy of the choice's telemetry data with extra information added */
function telemetryWithAddData(
	ctx: Context,
	document: TextDocumentContents,
	requestContext: RequestContext,
	choice: APIChoice,
	issuedTelemetryData: TelemetryWithExp
): TelemetryWithExp {
	const requestId = choice.requestId;
	const properties: { [key: string]: string } = {
		choiceIndex: choice.choiceIndex.toString(),
		clientCompletionId: choice.clientCompletionId,
	};
	if (choice.generatedChoiceIndex !== undefined) {
		properties.originalChoiceIndex = properties.choiceIndex;
		properties.choiceIndex = (10_000 * (choice.generatedChoiceIndex + 1) + choice.choiceIndex).toString();
	}
	const measurements: { [key: string]: number } = {
		compCharLen: choice.completionText.length,
		numLines: choice.completionText.trim().split('\n').length,
	};
	// Add assessments
	if (choice.meanLogProb) {
		measurements.meanLogProb = choice.meanLogProb;
	}
	if (choice.meanAlternativeLogProb) {
		measurements.meanAlternativeLogProb = choice.meanAlternativeLogProb;
	}

	const extendedTelemetry = choice.telemetryData.extendedBy(properties, measurements);
	extendedTelemetry.issuedTime = issuedTelemetryData.issuedTime;
	extendedTelemetry.measurements.timeToProduceMs = performance.now() - issuedTelemetryData.issuedTime;
	addDocumentTelemetry(extendedTelemetry, document);
	extendedTelemetry.extendWithRequestId(requestId);
	return extendedTelemetry;
}

/** Create new telemetry data based on baseTelemetryData and send `ghostText.issued` event  */
function telemetryIssued(
	ctx: Context,
	document: TextDocumentContents,
	requestContext: RequestContext,
	position: IPosition,
	prompt: PromptResponsePresent,
	baseTelemetryData: TelemetryWithExp,
	requestInfo: EngineRequestInfo,
	ghostTextOptions: GetGhostTextOptions
): TelemetryWithExp {
	// base ghostText telemetry data
	const properties: { [key: string]: string } = {
		languageId: document.detectedLanguageId,
	};
	properties.afterAccept = requestContext.afterAccept.toString();
	properties.isSpeculative = ghostTextOptions.isSpeculative.toString();
	const telemetryData = baseTelemetryData.extendedBy(properties);
	addDocumentTelemetry(telemetryData, document);

	// Add repository information
	const repoInfo = requestContext.repoInfo;
	telemetryData.properties.gitRepoInformation =
		repoInfo === undefined ? 'unavailable' : repoInfo === ComputationStatus.PENDING ? 'pending' : 'available';
	if (repoInfo !== undefined && repoInfo !== ComputationStatus.PENDING) {
		telemetryData.properties.gitRepoUrl = repoInfo.url;
		telemetryData.properties.gitRepoHost = repoInfo.hostname;
		if (repoInfo.repoId?.type === 'github') {
			telemetryData.properties.gitRepoOwner = repoInfo.repoId.org;
			telemetryData.properties.gitRepoName = repoInfo.repoId.repo;
		} else if (repoInfo.repoId?.type === 'ado') {
			telemetryData.properties.gitRepoOwner = repoInfo.repoId.project;
			telemetryData.properties.gitRepoName = repoInfo.repoId.repo;
		} else {
			// TODO: We don't have generic owner and repo for other providers
		}
		telemetryData.properties.gitRepoPath = repoInfo.pathname;
	}

	telemetryData.properties.engineName = requestInfo.modelId;
	telemetryData.properties.engineChoiceSource = requestInfo.engineChoiceSource;

	// Add requestMultiline information
	telemetryData.properties.isMultiline = JSON.stringify(requestContext.multiline);
	telemetryData.properties.isCycling = JSON.stringify(requestContext.isCycling);

	// calculated values for the issued event
	const currentLine = document.lineAt(position.line);
	const lineBeforeCursor = document.getText(LocationFactory.range(currentLine.range.start, position));
	const restOfLine = document.getText(LocationFactory.range(position, currentLine.range.end));

	const typeFileHashCode = Array.from(prompt.neighborSource.entries()).map(typeFiles => [
		typeFiles[0],
		typeFiles[1].map(f => createSha256Hash(f).toString()), // file name is sensitive. We just keep SHA256 of the file name.
	]);

	// Properties that we only want to include in the issued event
	const extendedProperties: TelemetryProperties = {
		beforeCursorWhitespace: JSON.stringify(lineBeforeCursor.trim() === ''),
		afterCursorWhitespace: JSON.stringify(restOfLine.trim() === ''),
		neighborSource: JSON.stringify(typeFileHashCode),
		blockMode: requestContext.blockMode,
	};
	const extendedMeasurements: TelemetryMeasurements = {
		...telemetrizePromptLength(prompt.prompt),
		promptEndPos: document.offsetAt(position),
		promptComputeTimeMs: prompt.computeTimeMs,
	};
	if (prompt.metadata) {
		extendedProperties.promptMetadata = JSON.stringify(prompt.metadata);
	}
	if (prompt.contextProvidersTelemetry) {
		extendedProperties.contextProviders = JSON.stringify(prompt.contextProvidersTelemetry);
	}
	const telemetryDataToSend = telemetryData.extendedBy(extendedProperties, extendedMeasurements);

	// telemetrize the issued event
	telemetry(ctx, 'ghostText.issued', telemetryDataToSend);

	return telemetryData;
}

function addDocumentTelemetry(telemetry: TelemetryWithExp, document: TextDocumentContents): void {
	telemetry.measurements.documentLength = document.getText().length;
	telemetry.measurements.documentLineCount = document.lineCount;
}

function telemetryPerformance(
	ctx: Context,
	performanceKind: string,
	choice: APIChoice,
	requestStart: number,
	processingTimeMs: number
) {
	const requestTimeMs = Date.now() - requestStart;
	const deltaMs = requestTimeMs - processingTimeMs;

	const telemetryData = choice.telemetryData.extendedBy(
		{},
		{
			completionCharLen: choice.completionText.length,
			requestTimeMs: requestTimeMs,
			processingTimeMs: processingTimeMs,
			deltaMs: deltaMs,
			// Choice properties
			meanLogProb: choice.meanLogProb || NaN,
			meanAlternativeLogProb: choice.meanAlternativeLogProb || NaN,
		}
	);
	telemetryData.extendWithRequestId(choice.requestId);
	telemetry(ctx, `ghostText.${performanceKind}`, telemetryData);
}
