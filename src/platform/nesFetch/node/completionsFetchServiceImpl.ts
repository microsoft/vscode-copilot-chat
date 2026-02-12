/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterUtilsExt } from '../../../util/common/asyncIterableUtils';
import * as errors from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { getRequestId, RequestId } from '../../networking/common/fetch';
import { FetchOptions, IFetcherService, IHeaders, Response } from '../../networking/common/fetcherService';
import { Completions, ICompletionsFetchService } from '../common/completionsFetchService';
import { ResponseStream } from '../common/responseStream';
import { jsonlStreamToCompletions } from './streamTransformer';

export type FetchResponse = {
	status: number;
	statusText: string;
	headers: IHeaders;
	body: AsyncIterable<string>;
	requestId: RequestId;
	response: Response;
};

export interface IFetchRequestParams extends Completions.ModelParams { }

/**
 * Azure-only fork: detect Azure OpenAI endpoints so we can transform
 * legacy /completions requests into /chat/completions format.
 */
function isAzureChatCompletionsUrl(url: string): boolean {
	return (url.includes('.openai.azure.com') || url.includes('.cognitiveservices.azure.com'))
		&& url.includes('/chat/completions');
}

export class CompletionsFetchService implements ICompletionsFetchService {
	readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private authService: IAuthenticationService,
		@IFetcherService private fetcherService: IFetcherService,
	) {
	}

	public disconnectAll(): Promise<unknown> {
		return this.fetcherService.disconnectAll();
	}

	public async fetch(
		url: string,
		secretKey: string,
		params: IFetchRequestParams,
		requestId: string,
		ct: CancellationToken,
		headerOverrides?: Record<string, string>,
	): Promise<Result<ResponseStream, Completions.CompletionsFetchFailure>> {

		if (ct.isCancellationRequested) {
			return Result.error(new Completions.RequestCancelled());
		}

		const isAzureChat = isAzureChatCompletionsUrl(url);

		// Azure-only fork: for Azure /chat/completions, transform the FIM
		// request body from legacy completions format to chat messages format
		let body: string;
		if (isAzureChat) {
			body = JSON.stringify(toChatCompletionsBody(params));
		} else {
			body = JSON.stringify({
				...params,
				stream: true,
			});
		}

		// Azure-only fork: strip GitHub-specific headers for Azure endpoints
		const headers = this.getHeaders(requestId, secretKey, headerOverrides, isAzureChat);

		const options = {
			requestId,
			headers,
			body,
		};

		const fetchResponse = await this._fetchFromUrl(url, options, ct);

		if (fetchResponse.isError()) {
			return fetchResponse;
		}

		if (fetchResponse.val.status === 200) {

			const jsonlStream = AsyncIterUtilsExt.splitLines(fetchResponse.val.body);

			// Azure-only fork: if this is a chat completions response, transform
			// the SSE events from chat format ({delta.content}) to completions
			// format ({text}) so downstream processing works unchanged
			const completionsStream = isAzureChat
				? chatJsonlStreamToCompletions(jsonlStream)
				: jsonlStreamToCompletions(jsonlStream);

			const response = new ResponseStream(fetchResponse.val.response, completionsStream, fetchResponse.val.requestId, fetchResponse.val.headers);

			return Result.ok(response);

		} else {
			const error: Completions.CompletionsFetchFailure = new Completions.UnsuccessfulResponse(
				fetchResponse.val.status,
				fetchResponse.val.statusText,
				fetchResponse.val.headers,
				() => collectAsyncIterableToString(fetchResponse.val.body).catch(() => ''),
			);

			return Result.error(error);
		}
	}

	protected async _fetchFromUrl(url: string, options: Completions.Internal.FetchOptions, ct: CancellationToken): Promise<Result<FetchResponse, Completions.CompletionsFetchFailure>> {

		const fetchAbortCtl = this.fetcherService.makeAbortController();

		const onCancellationDisposable = ct.onCancellationRequested(() => {
			fetchAbortCtl.abort();
		});

		try {

			const request: FetchOptions = {
				headers: options.headers,
				body: options.body,
				signal: fetchAbortCtl.signal,
				method: 'POST',
			};

			const response = await this.fetcherService.fetch(url, request);

			if (response.status === 200 && this.authService.copilotToken?.isFreeUser && this.authService.copilotToken?.isChatQuotaExceeded) {
				this.authService.resetCopilotToken();
			}

			if (response.status !== 200) {
				if (response.status === 402) {
					// When we receive a 402, we have exceed the free tier quota
					// This is stored on the token so let's refresh it
					if (!this.authService.copilotToken?.isCompletionsQuotaExceeded) {
						this.authService.resetCopilotToken(response.status);
						await this.authService.getCopilotToken();
					}
				}

				return Result.error(new Completions.UnsuccessfulResponse(response.status, response.statusText, response.headers, () => response.text().catch(() => '')));
			}

			const body = response.body.pipeThrough(new TextDecoderStream());

			const responseStream = streamWithCleanup(body, onCancellationDisposable);

			return Result.ok({
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body: responseStream,
				requestId: getRequestId(response.headers),
				response,
			});

		} catch (reason: unknown) {

			onCancellationDisposable.dispose();

			if (reason instanceof Error && reason.message === 'This operation was aborted') {
				return Result.error(new Completions.RequestCancelled());
			}

			const error = errors.fromUnknown(reason);
			return Result.error(new Completions.Unexpected(error));
		}
	}

	private getHeaders(
		requestId: string,
		secretKey: string,
		headerOverrides: Record<string, string> = {},
		isAzure: boolean = false,
	): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ' + secretKey,
			'X-Request-Id': requestId,
			...headerOverrides,
		};

		// Azure-only fork: strip GitHub-specific headers for Azure endpoints
		if (isAzure) {
			delete headers['Openai-Organization'];
			delete headers['X-GitHub-Api-Version'];
			delete headers['x-policy-id'];
		} else {
			if (!headers['x-policy-id']) {
				headers['x-policy-id'] = 'nil';
			}
			if (!headers['X-GitHub-Api-Version']) {
				headers['X-GitHub-Api-Version'] = '2025-04-01';
			}
		}

		return headers;
	}
}

/**
 * Azure-only fork: convert a legacy completions request body (prompt + suffix)
 * into a chat completions request body (messages array).
 *
 * The FIM (fill-in-the-middle) prompt is converted to a system instruction
 * plus a user message so that modern Azure models can produce code completions.
 */
function toChatCompletionsBody(params: IFetchRequestParams): Record<string, unknown> {
	const { prompt, suffix, extra, nwo, ...rest } = params as unknown as Record<string, unknown>;

	const messages: Array<{ role: string; content: string }> = [];

	messages.push({
		role: 'system',
		content: 'You are a code completion assistant. You will be given code context (prefix and optionally suffix). Output ONLY the code that should be inserted at the cursor position. Do not include explanations, markdown formatting, or code fences. Do not repeat the prefix or suffix.',
	});

	let userContent = '';
	if (prompt && typeof prompt === 'string') {
		userContent += prompt;
	}
	if (suffix && typeof suffix === 'string') {
		userContent += `\n[CURSOR_POSITION]\n${suffix}`;
	}

	if (userContent) {
		messages.push({ role: 'user', content: userContent });
	}

	return {
		messages,
		stream: true,
		max_tokens: rest.max_tokens ?? 500,
		temperature: rest.temperature ?? 0,
		top_p: rest.top_p,
		n: rest.n ?? 1,
		stop: rest.stop,
	};
}

/**
 * Azure-only fork: transform a chat completions SSE stream into the
 * legacy completions format that the downstream SSE processor expects.
 *
 * Chat completions streaming:   {"choices": [{"delta": {"content": "text"}, "index": 0, "finish_reason": null}]}
 * Legacy completions streaming: {"choices": [{"text": "text", "index": 0, "finish_reason": null}]}
 */
async function* chatJsonlStreamToCompletions(jsonlStream: AsyncIterable<string>): AsyncGenerator<import('../common/completionsAPI').Completion> {
	for await (const line of jsonlStream) {
		if (line.trim() === 'data: [DONE]') {
			continue;
		}

		if (line.startsWith('data: ')) {
			const message = JSON.parse(line.substring('data: '.length));

			if (message.error) {
				throw new Error(message.error.message);
			}

			// Transform chat completions choices to legacy completions format
			const transformedChoices = (message.choices || []).map((choice: {
				index: number;
				delta?: { content?: string; role?: string };
				finish_reason: string | null;
			}) => ({
				index: choice.index,
				text: choice.delta?.content ?? '',
				finish_reason: choice.finish_reason,
			}));

			yield {
				choices: transformedChoices,
				system_fingerprint: message.system_fingerprint ?? '',
				object: 'text_completion',
				usage: message.usage,
			};
		}
	}
}

/**
 * Wraps an async iterable stream and disposes the cleanup disposable when the stream completes or errors.
 */
async function* streamWithCleanup(
	stream: AsyncIterable<string>,
	cleanupDisposable: IDisposable
): AsyncGenerator<string> {
	try {
		for await (const str of stream) {
			yield str;
		}
	} catch (err: unknown) {
		const error = errors.fromUnknown(err);
		throw error;
	} finally {
		cleanupDisposable.dispose();
	}
}

/**
 * Collects all strings from an async iterable and joins them into a single string.
 */
async function collectAsyncIterableToString(iterable: AsyncIterable<string>): Promise<string> {
	const parts: string[] = [];
	for await (const part of iterable) {
		parts.push(part);
	}
	return parts.join('');
}
