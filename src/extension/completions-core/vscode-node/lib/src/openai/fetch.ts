/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientHttp2Stream } from 'http2';
import { CancellationToken as ICancellationToken } from '../../../types/src';
import { CopilotToken, CopilotTokenManager } from '../auth/copilotTokenManager';
import { onCopilotToken } from '../auth/copilotTokenNotifier';
import { Context } from '../context';
import { Features } from '../experiments/features';
import { asyncIterableFilter, asyncIterableMap } from '../helpers/iterableHelpers';
import { Logger } from '../logger';
import { getEndpointUrl } from '../networkConfiguration';
import { Response, isAbortError, postRequest } from '../networking';
import { StatusReporter } from '../progress';
import { Prompt } from '../prompt/prompt';
import { MaybeRepoInfo, tryGetGitHubNWO } from '../prompt/repository';
import {
	TelemetryData,
	TelemetryWithExp,
	logEnginePrompt,
	now,
	telemetrizePromptLength,
	telemetry,
} from '../telemetry';
import { delay } from '../util/async';
import { getKey } from '../util/unknown';
import {
	APIChoice,
	APIJsonData,
	RequestId,
	getMaxSolutionTokens,
	getStops,
	getTemperatureForSamples,
	getTopP,
} from './openai';
import { CopilotAnnotations, SSEProcessor, prepareSolutionForReturn } from './stream';

const logger = new Logger('fetchCompletions');

export enum CopilotUiKind {
	GhostText = 'ghostText',
	Panel = 'synthesize', // legacy value from the synthesize codelens
}

type BaseFetchRequest = {
	/**
	 * The prompt prefix to send to the model.  Called `prompt` here for compatibility
	 * with the OpenAI API.
	 */
	prompt: string;
};

/**
 * Request parameters other than the prompt, which will be included in the OAI
 * API request.
 */
type CompletionFetchRequestFields = {
	/** The prompt suffix to send to the model. */
	suffix: string;
	/** Whether to stream back a response in SSE format. Always true: non streaming requests are not supported by this proxy */
	stream: boolean;
	/** Maximum number of tokens the model should generate. */
	max_tokens: number;
	/** How many parallel completions the model should generate (default 1). */
	n: number;
	/** Non-negative temperature sampling parameter (default 1). */
	temperature: number;
	/** Non-negative nucleus sampling parameter (defaults 1). */
	top_p: number;
	/** Strings that will cause the model to stop generating text. */
	stop: string[];
	/** Number of alternative tokens to include logprob data for. */
	logprobs?: number;
	/** Likelihood of specified tokens appearing in the completion. */
	logit_bias?: { [key: string]: number };

	/** Copilot-only: NWO of repository, if any */
	nwo?: string;
	/**
	 * Controls whether code citation annotations are included in the response
	 * stream for non-blocking requests.
	 */
	code_annotations?: boolean;
};

/** OAI API completion request, along with additional fields specific to Copilot. */
type CompletionRequest = BaseFetchRequest &
	CompletionFetchRequestFields & {
		/** Copilot-only: extra arguments for completion processing. */
		extra: Partial<CompletionRequestExtra>;
	};

/**
 * Completion request arguments that are Copilot-specific and don't exist in
 * the OAI API.
 */
export declare interface CompletionRequestExtra {
	/** The VSCode language ID for the file. */
	language: string;
	/**
	 * If true, the proxy will trim completions to the current block/line based
	 * on the force_indent and/or next_indent values.
	 */
	trim_by_indentation?: boolean;
	/**
	 * If set, will let the completion go on until a (non-continuation) line
	 * comes through with the given indentation level.
	 */
	force_indent?: number;
	/** Number of leading space or tab characters in the next non-empty line. */
	next_indent?: number;
	/**
	 * For testing only: A list of completions to be used instead of calling the
	 * model. The server will act as if the model returned these completions and
	 * postprocess them as it normally postprocesses model responses (i.e.
	 * filtering, trimming, etc.).
	 */
	test_completions?: string[];
	/**
	 The number of tokens (prefix)
	 */
	prompt_tokens: number;
	/**
	 The number of tokens (suffix)
	 */
	suffix_tokens: number;
	/** Additional context to send to the model.
	 * If this field is populated, then `prefix` will only contain the document prefix before the cursor.*/
	context?: string[];
}

export type PostOptions = Partial<CompletionFetchRequestFields>;

// Request helpers

export function getRequestId(response: Response): RequestId {
	return {
		headerRequestId: response.headers.get('x-request-id') || '',
		serverExperiments: response.headers.get('X-Copilot-Experiment') || '',
		deploymentId: response.headers.get('azureml-model-deployment') || '',
	};
}

function getProcessingTime(response: Response): number {
	const reqIdStr = response.headers.get('openai-processing-ms');
	if (reqIdStr) {
		return parseInt(reqIdStr, 10);
	}
	return 0;
}

function uiKindToIntent(uiKind: CopilotUiKind): string | undefined {
	switch (uiKind) {
		case CopilotUiKind.GhostText:
			return 'copilot-ghost';
		case CopilotUiKind.Panel:
			return 'copilot-panel';
	}
}

// Request methods

export interface CopilotError {
	type: string;
	code: string;
	message: string;
	identifier: string;
}

export interface CopilotConfirmation {
	type: string;
	title: string;
	message: string;
	confirmation: Record<string, unknown>;
}

export interface CopilotReference {
	type: string;
	id: string;
	data: Record<string, unknown>;
}

export interface RequestDelta {
	text: string;
	index?: number;
	requestId?: RequestId;
	annotations?: CopilotAnnotations;
	copilotErrors?: CopilotError[];
	copilotConfirmation?: CopilotConfirmation;
	copilotReferences?: CopilotReference[];
	getAPIJsonData?: () => APIJsonData;
	finished?: boolean;
	telemetryData?: TelemetryWithExp;
}

export interface SolutionDecision {
	yieldSolution: boolean;
	continueStreaming: boolean;
	finishOffset?: number;
}

type FinishedCallbackResult =
	| Promise<SolutionDecision | number | undefined>
	| SolutionDecision
	| number
	| undefined;

/**
 * Takes a (part of a) completion resolves to the offset of the end of the
 * block, or undefined if the block is not yet finished.
 */
export interface FinishedCallback {
	(text: string, delta: RequestDelta): FinishedCallbackResult;
}

interface InternalFetchParams {
	prompt: Prompt;
	engineModelId: string;
	uiKind: CopilotUiKind;
	ourRequestId: string;
	headers?: CompletionHeaders;
}

/**
 * Interface for the parameters passed to `fetchAndStreamCompletions` and `fetchWithParameters` wrappers,
 * which then turn them into a `CompletionRequest` to be sent with `fetchWithInstrumentation`.
 */
export interface CompletionParams extends InternalFetchParams {
	repoInfo: MaybeRepoInfo;
	languageId: string;
	count: number;
	requestLogProbs?: boolean;
	postOptions?: PostOptions;
	extra: Partial<CompletionRequestExtra>;
}

/**
 * Interface for the parameters passed to `fetchSpeculationWithParameters`,
 * which then turns them into a `SpeculationCompletionRequest` object to be sent with `fetchWithInstrumentation`.
 */
export interface SpeculationFetchParams extends InternalFetchParams {
	speculation: string;
	stops: string[] | null;
}

/** An interface to abstract away the network request to OpenAI, allowing for
 * fake or mock implementations. It's deliberately injected relatively high
 * in the call stack to avoid having to reconstruct some of the lower-level details
 * of the OpenAI API.
 */
export abstract class OpenAIFetcher {
	/**
	 * Sends a request to the code completion endpoint.
	 */
	abstract fetchAndStreamCompletions(
		ctx: Context,
		params: CompletionParams,
		baseTelemetryData: TelemetryWithExp,
		finishedCb: FinishedCallback,
		cancellationToken?: ICancellationToken
	): Promise<CompletionResults | CompletionError>;
}

export interface CompletionResults {
	type: 'success';
	choices: AsyncIterable<APIChoice>;
	getProcessingTime(): number;
}

export type CompletionError = { type: 'failed'; reason: string } | { type: 'canceled'; reason: string };

export type CompletionHeaders = {
	/** For speculation only**/
	Host?: string;
	Connection?: string;
	'X-Copilot-Async'?: string;
	'X-Copilot-Speculative'?: string;
};

function getProxyEngineUrl(ctx: Context, token: CopilotToken, modelId: string, endpoint: string): string {
	return getEndpointUrl(ctx, token, 'proxy', 'v1/engines', modelId, endpoint);
}

export function sanitizeRequestOptionTelemetry(
	request: Partial<CompletionRequest>,
	telemetryData: TelemetryWithExp,
	topLevelKeys: string[], // top-level properties to exclude from standard telemetry
	extraKeys?: (keyof CompletionRequestExtra)[] // keys under the `extra` property to exclude from standard telemetry
): void {
	for (const [key, value] of Object.entries(request)) {
		if (topLevelKeys.includes(key)) {
			continue;
		}

		let valueToLog = value as unknown;

		if (key === 'extra' && extraKeys) {
			const extra = { ...(valueToLog as CompletionRequestExtra) };
			for (const extraKey of extraKeys) {
				delete extra[extraKey];
			}
			valueToLog = extra;
		}

		telemetryData.properties[`request.option.${key}`] = JSON.stringify(valueToLog) ?? 'undefined';
	}
}

async function fetchWithInstrumentation(
	ctx: Context,
	prompt: Prompt,
	engineModelId: string,
	endpoint: string,
	ourRequestId: string,
	request: Record<string, unknown>,
	copilotToken: CopilotToken,
	uiKind: CopilotUiKind,
	telemetryExp: TelemetryWithExp,
	cancel?: ICancellationToken,
	headers?: CompletionHeaders
): Promise<Response> {
	const statusReporter = ctx.get(StatusReporter);
	const uri = getProxyEngineUrl(ctx, copilotToken, engineModelId, endpoint);

	const telemetryData = telemetryExp.extendedBy(
		{
			endpoint: endpoint,
			engineName: engineModelId,
			uiKind: uiKind,
		},
		telemetrizePromptLength(prompt)
	);

	// Skip prompt info (PII)
	sanitizeRequestOptionTelemetry(request, telemetryData, ['prompt', 'suffix'], ['context']);

	// The request ID we are passed in is sent in the request to the proxy, and included in our pre-request telemetry.
	// We hope (but do not rely on) that the model will use the same ID in the response, allowing us to correlate
	// the request and response.
	telemetryData.properties['headerRequestId'] = ourRequestId;

	telemetry(ctx, 'request.sent', telemetryData);

	const requestStart = now();
	const intent = uiKindToIntent(uiKind);

	// Wrap the Promise with success/error callbacks so we can log/measure it
	return postRequest(ctx, uri, copilotToken.token, intent, ourRequestId, request, cancel, headers)
		.then(response => {
			// This ID is hopefully the one the same as ourRequestId, but it is not guaranteed.
			// If they are different then we will override the original one we set in telemetryData above.
			const modelRequestId = getRequestId(response);
			telemetryData.extendWithRequestId(modelRequestId);

			// TODO: Add response length (requires parsing)
			const totalTimeMs = now() - requestStart;
			telemetryData.measurements.totalTimeMs = totalTimeMs;

			logger.info(
				ctx,
				`Request ${ourRequestId} at <${uri}> finished with ${response.status} status after ${totalTimeMs}ms`
			);
			telemetryData.properties.status = String(response.status);
			logger.debug(ctx, 'request.response properties', telemetryData.properties);
			logger.debug(ctx, 'request.response measurements', telemetryData.measurements);

			logger.debug(ctx, 'prompt:', prompt);

			telemetry(ctx, 'request.response', telemetryData);

			return response;
		})
		.catch((error: unknown) => {
			if (isAbortError(error)) {
				// If we cancelled a network request, we want to log a `request.cancel` instead of `request.error`
				telemetry(ctx, 'request.cancel', telemetryData);
				throw error;
			}
			statusReporter.setWarning(getKey(error, 'message') ?? '');
			const warningTelemetry = telemetryData.extendedBy({ error: 'Network exception' });
			telemetry(ctx, 'request.shownWarning', warningTelemetry);

			telemetryData.properties.message = String(getKey(error, 'name') ?? '');
			telemetryData.properties.code = String(getKey(error, 'code') ?? '');
			telemetryData.properties.errno = String(getKey(error, 'errno') ?? '');
			telemetryData.properties.type = String(getKey(error, 'type') ?? '');

			const totalTimeMs = now() - requestStart;
			telemetryData.measurements.totalTimeMs = totalTimeMs;

			logger.info(
				ctx,
				`Request ${ourRequestId} at <${uri}> rejected with ${String(error)} after ${totalTimeMs}ms`
			);
			logger.debug(ctx, 'request.error properties', telemetryData.properties);
			logger.debug(ctx, 'request.error measurements', telemetryData.measurements);

			telemetry(ctx, 'request.error', telemetryData);

			throw error;
		})
		.finally(() => {
			logEnginePrompt(ctx, prompt, telemetryData);
		});
}

export function postProcessChoices(choices: AsyncIterable<APIChoice>) {
	return asyncIterableFilter(choices, choice => choice.completionText.trim().length > 0);
}

export const CMDQuotaExceeded = 'github.copilot.completions.quotaExceeded';

export class LiveOpenAIFetcher extends OpenAIFetcher {
	#disabledReason: string | undefined;

	async fetchAndStreamCompletions(
		ctx: Context,
		params: CompletionParams,
		baseTelemetryData: TelemetryWithExp,
		finishedCb: FinishedCallback,
		cancel?: ICancellationToken
	): Promise<CompletionResults | CompletionError> {
		if (this.#disabledReason) {
			return { type: 'canceled', reason: this.#disabledReason };
		}
		const statusReporter = ctx.get(StatusReporter);
		const endpoint = 'completions';
		const tokenManager = ctx.get(CopilotTokenManager);
		const copilotToken = tokenManager.token ?? await tokenManager.getToken();
		const response = await this.fetchWithParameters(ctx, endpoint, params, copilotToken, baseTelemetryData, cancel);
		if (response === 'not-sent') {
			return { type: 'canceled', reason: 'before fetch request' };
		}
		if (cancel?.isCancellationRequested) {
			const body = response.body();
			try {
				// Destroy the stream so that the server is hopefully notified we don't want any more data
				// and can cancel/forget about the request itself.
				if (body && 'destroy' in body && typeof body.destroy === 'function') {
					(body as unknown as ClientHttp2Stream).destroy();
				} else if (body instanceof ReadableStream) {
					void body.cancel();
				}
			} catch (e) {
				logger.exception(ctx, e, `Error destroying stream`);
			}
			return { type: 'canceled', reason: 'after fetch request' };
		}

		if (response.status !== 200) {
			const telemetryData = this.createTelemetryData(endpoint, ctx, params);
			return this.handleError(ctx, statusReporter, telemetryData, response, copilotToken);
		}
		const processor = await SSEProcessor.create(ctx, params.count, response, baseTelemetryData, [], cancel);
		const finishedCompletions = processor.processSSE(finishedCb);
		const choices = asyncIterableMap(finishedCompletions, solution =>
			prepareSolutionForReturn(ctx, solution, baseTelemetryData)
		);
		return {
			type: 'success',
			choices: postProcessChoices(choices),
			getProcessingTime: () => getProcessingTime(response),
		};
	}

	private createTelemetryData(endpoint: string, ctx: Context, params: CompletionParams | SpeculationFetchParams) {
		return TelemetryData.createAndMarkAsIssued({
			endpoint: endpoint,
			engineName: params.engineModelId,
			uiKind: params.uiKind,
			headerRequestId: params.ourRequestId,
		});
	}

	async fetchWithParameters(
		ctx: Context,
		endpoint: string,
		params: CompletionParams,
		copilotToken: CopilotToken,
		baseTelemetryData: TelemetryWithExp,
		cancel?: ICancellationToken
	): Promise<Response | 'not-sent'> {
		const disableLogProb = ctx.get(Features).disableLogProb(baseTelemetryData);

		const request: CompletionRequest = {
			prompt: params.prompt.prefix,
			suffix: params.prompt.suffix,
			max_tokens: getMaxSolutionTokens(ctx),
			temperature: getTemperatureForSamples(ctx, params.count),
			top_p: getTopP(ctx),
			n: params.count,
			stop: getStops(ctx, params.languageId),
			stream: true, // Always true: non streaming requests are not supported by this proxy
			extra: params.extra,
		};

		if (params.requestLogProbs || !disableLogProb) {
			request.logprobs = 2; // Request that logprobs of 2 tokens (i.e. including the best alternative) be returned
		}

		const githubNWO = tryGetGitHubNWO(params.repoInfo);
		if (githubNWO !== undefined) {
			request.nwo = githubNWO;
		}

		if (params.postOptions) {
			Object.assign(request, params.postOptions);
		}

		if (params.prompt.context && params.prompt.context.length > 0) {
			request.extra.context = params.prompt.context;
		}

		// Give a final opportunity to cancel the request before we send the request
		// This await line is necessary to allow the tests in extension/src/openai.test.ts to pass
		await delay(0);
		if (cancel?.isCancellationRequested) {
			return 'not-sent';
		}

		const response = await fetchWithInstrumentation(
			ctx,
			params.prompt,
			params.engineModelId,
			endpoint,
			params.ourRequestId,
			request,
			copilotToken,
			params.uiKind,
			baseTelemetryData,
			cancel,
			params.headers
		);
		return response;
	}

	async handleError(
		ctx: Context,
		statusReporter: StatusReporter,
		telemetryData: TelemetryData,
		response: Response,
		copilotToken: CopilotToken
	): Promise<CompletionError> {
		const text = await response.text();
		if (response.status === 402) {
			this.#disabledReason = 'monthly free code completions exhausted';
			const message = 'Completions limit reached';
			statusReporter.setError(message, {
				command: CMDQuotaExceeded,
				title: 'Learn More',
			});
			const event = onCopilotToken(ctx, t => {
				this.#disabledReason = undefined;
				if (!t.isCompletionsQuotaExceeded) {
					statusReporter.forceNormal();
					event.dispose();
				}
			});
			return { type: 'failed', reason: this.#disabledReason };
		}
		if (response.status === 466) {
			statusReporter.setError(text);
			logger.info(ctx, text);
			return { type: 'failed', reason: `client not supported: ${text}` };
		}
		if (isClientError(response) && !response.headers.get('x-github-request-id')) {
			const message = `Last response was a ${response.status} error and does not appear to originate from GitHub. Is a proxy or firewall intercepting this request? https://gh.io/copilot-firewall`;
			logger.error(ctx, message);
			statusReporter.setWarning(message);
			telemetryData.properties.error = `Response status was ${response.status} with no x-github-request-id header`;
		} else if (isClientError(response)) {
			logger.warn(ctx, `Response status was ${response.status}:`, text);
			statusReporter.setWarning(`Last response was a ${response.status} error: ${text}`);
			telemetryData.properties.error = `Response status was ${response.status}: ${text}`;
		} else {
			statusReporter.setWarning(`Last response was a ${response.status} error`);
			telemetryData.properties.error = `Response status was ${response.status}`;
		}
		telemetryData.properties.status = String(response.status);
		telemetry(ctx, 'request.shownWarning', telemetryData);
		// check for 4xx responses which will point to a forbidden
		if (response.status === 401 || response.status === 403) {
			// Token has expired or invalid, fetch a new one on next request
			// TODO(drifkin): these actions should probably happen in vsc specific code
			ctx.get(CopilotTokenManager).resetToken(response.status);
			return { type: 'failed', reason: `token expired or invalid: ${response.status}` };
		}
		if (response.status === 429) {
			const rateLimitSeconds = 10;
			setTimeout(() => {
				this.#disabledReason = undefined;
			}, rateLimitSeconds * 1000);
			this.#disabledReason = 'rate limited';
			logger.warn(ctx, `Rate limited by server. Denying completions for the next ${rateLimitSeconds} seconds.`);
			return { type: 'failed', reason: this.#disabledReason };
		}
		if (response.status === 499) {
			logger.info(ctx, 'Cancelled by server');
			return { type: 'failed', reason: 'canceled by server' };
		}
		logger.error(ctx, 'Unhandled status from server:', response.status, text);
		return { type: 'failed', reason: `unhandled status from server: ${response.status} ${text}` };
	}
}

function isClientError(response: Response): boolean {
	return response.status >= 400 && response.status < 500;
}
