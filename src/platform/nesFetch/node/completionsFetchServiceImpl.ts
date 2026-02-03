/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorUtils } from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { getRequestId, RequestId } from '../../networking/common/fetch';
import { FetchOptions, IFetcherService, IHeaders, Response } from '../../networking/common/fetcherService';
import { Completions, ICompletionsFetchService } from '../common/completionsFetchService';
import { ResponseStream } from '../common/responseStream';
import { jsonlStreamToCompletions, streamToLines } from './streamTransformer';

export type FetchResponse = {
	status: number;
	statusText: string;
	headers: IHeaders;
	body: AsyncIterable<string>;
	requestId: RequestId;
	response: Response;
};

export interface IFetchRequestParams extends Completions.ModelParams { }

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

		const options = {
			requestId,
			headers: this.getHeaders(requestId, secretKey, headerOverrides),
			body: JSON.stringify({
				...params,
				stream: true,
			})
		};

		const fetchResponse = await this._fetchFromUrl(url, options, ct);

		if (fetchResponse.isError()) {
			return fetchResponse;
		}

		if (fetchResponse.val.status === 200) {

			const jsonlStream = streamToLines(fetchResponse.val.body);
			const completionsStream = jsonlStreamToCompletions(jsonlStream);

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

			const error = ErrorUtils.fromUnknown(reason);
			return Result.error(new Completions.Unexpected(error));
		}
	}

	private getHeaders(
		requestId: string,
		secretKey: string,
		headerOverrides: Record<string, string> = {},
	): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-policy-id': 'nil',
			Authorization: 'Bearer ' + secretKey,
			'X-Request-Id': requestId,
			'X-GitHub-Api-Version': '2025-04-01',
			...headerOverrides,
		};

		return headers;
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
		const error = ErrorUtils.fromUnknown(err);
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
