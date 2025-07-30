/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import * as stream_consumers from 'stream/consumers';
import { Result } from '../../../util/common/result';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { safeStringify } from '../../../util/vs/base/common/objects';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IFetcherService, IHeaders } from '../../networking/common/fetcherService';
import { CompletionsFetchFailure, FetchOptions, ICompletionsFetchService, ModelParams } from '../common/completionsFetchService';
import { ResponseStream } from '../common/responseStream';
import { jsonlStreamToCompletions, streamToLines } from './streamTransformer';

export type FetchResponse = {
	status: number;
	statusText: string;
	headers: { [name: string]: string };
	body: AsyncIterableObject<string>;
};

export interface IFetchRequestParams extends ModelParams { }

export class CompletionsFetchService implements ICompletionsFetchService {
	readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private authService: IAuthenticationService,
		@IFetcherService private fetcherService: IFetcherService,
	) {
	}

	public async fetch(
		url: string,
		secretKey: string,
		params: IFetchRequestParams,
		requestId: string,
		ct: CancellationToken,
		headerOverrides?: Record<string, string>,
	): Promise<Result<ResponseStream, CompletionsFetchFailure>> {

		if (ct.isCancellationRequested) {
			return Result.error({ kind: 'cancelled' });
		}

		const options = {
			requestId,
			headers: this.getHeaders(requestId, secretKey, headerOverrides),
			body: {
				...params,
				stream: true,
			}
		};

		const fetchResponse = await this._fetchFromUrl(url, options, ct);

		if (fetchResponse.isError()) {
			return fetchResponse;
		}

		if (fetchResponse.val.status === 200) {

			const jsonlStream = streamToLines(fetchResponse.val.body);
			const completionsStream = jsonlStreamToCompletions(jsonlStream);

			const completions = completionsStream.map(completion => {
				return {
					...completion,
					choices: completion.choices.filter(choice => choice.index === 0),
				};
			}).filter(c => {
				return c.choices.length > 0;
			}); // we only support `n=1`, so we only get choice.index = 0

			const response = new ResponseStream(completions);

			return Result.ok(response);

		} else {

			const body = await stream_consumers.text(fetchResponse.val.body);
			if (body.match(/This model's maximum context length is /)) {
				return Result.error({ kind: 'context-window-exceeded', message: body });
			}
			if (
				body.match(
					/Access denied due to invalid subscription key or wrong API endpoint/
				) || fetchResponse.val.status === 401 || fetchResponse.val.status === 403
			) {
				return Result.error({ kind: 'invalid-api-key', message: body });
			}
			if (body.match(/exceeded call rate limit/)) {
				return Result.error({ kind: 'exceeded-rate-limit', message: body });
			}
			const error: CompletionsFetchFailure = {
				kind: 'not-200-status',
				status: fetchResponse.val.status,
				statusText: fetchResponse.val.statusText,
			};
			return Result.error(error);
		}
	}

	protected async _fetchFromUrl(url: string, options: FetchOptions, ct: CancellationToken): Promise<Result<FetchResponse, CompletionsFetchFailure>> {

		const fetchAbortCtl = this.fetcherService.makeAbortController();

		const onCancellationDisposable = ct.onCancellationRequested(() => {
			fetchAbortCtl.abort();
		});

		try {

			const response = await this.fetcherService.fetch(url, {
				headers: options.headers,
				json: options.body,
				signal: fetchAbortCtl.signal,
				method: 'POST',
			});

			if (response.status === 200 && this.authService.copilotToken?.isFreeUser && this.authService.copilotToken?.isChatQuotaExceeded) {
				this.authService.resetCopilotToken();
			}

			if (response.status !== 200) {
				if (response.status === 402) {
					// When we receive a 402, we have exceed the free tier quota
					// This is stored on the token so let's refresh it
					this.authService.resetCopilotToken(response.status);
					return Result.error<CompletionsFetchFailure>({ kind: 'quota-exceeded' });
				}

				const error: CompletionsFetchFailure = {
					kind: 'not-200-status',
					status: response.status,
					statusText: response.statusText,
				};
				return Result.error(error);
			}

			const responseBody = await response.body();

			const body = (
				responseBody instanceof Readable
					? responseBody
					: (
						responseBody
							? new Readable().wrap(responseBody as NodeJS.ReadableStream)
							: new Readable()
					)
			);

			body.setEncoding('utf8');

			const responseStream = new AsyncIterableObject<string>(async (emitter) => {
				try {
					for await (const str of body) {
						emitter.emitOne(str);
					}
				} catch (err: unknown) {
					if (!(err instanceof Error)) {
						throw new Error(safeStringify(err));
					}

					if (this.fetcherService.isAbortError(err) || err.name === 'AbortError') {
						// stream aborted - ignore
					} else if (
						err.message === 'ERR_HTTP2_STREAM_ERROR' ||
						(err as any).code === 'ERR_HTTP2_STREAM_ERROR'
					) {
						// stream closed - ignore
					} else {
						throw err;
					}
				} finally {
					onCancellationDisposable.dispose();
				}
			});

			return Result.ok({
				status: response.status,
				statusText: response.statusText,
				headers: headersObjectToKv(response.headers),
				body: responseStream,
			});

		} catch (reason: any) { // TODO: replace with unknown with proper error handling

			onCancellationDisposable.dispose();

			if (reason instanceof Error && reason.message === 'This operation was aborted') {
				return Result.error({ kind: 'cancelled', errorMessage: reason.message });
			}

			if (
				reason.code === 'ECONNRESET' ||
				reason.code === 'ETIMEDOUT' ||
				reason.code === 'ERR_HTTP2_INVALID_SESSION' ||
				reason.message === 'ERR_HTTP2_GOAWAY_SESSION' ||
				reason.code === '429'
			) {
				return Result.error({ kind: 'model_overloaded', errorMessage: reason.message });
			} else {
				return Result.error({ kind: 'model_error', errorMessage: reason.message });
			}
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

function headersObjectToKv(headers: IHeaders): { [name: string]: string } {
	const result: { [name: string]: string } = {};
	for (const [name, value] of headers) {
		result[name] = value;
	}
	return result;
}
