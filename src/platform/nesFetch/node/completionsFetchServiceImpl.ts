/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import * as errors from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IFetcherService, IHeaders } from '../../networking/common/fetcherService';
import { Completions, ICompletionsFetchService } from '../common/completionsFetchService';
import { ResponseStream } from '../common/responseStream';
import { jsonlStreamToCompletions, streamToLines } from './streamTransformer';

export type FetchResponse = {
	status: number;
	statusText: string;
	headers: { [name: string]: string };
	body: AsyncIterableObject<string>;
};

export interface IFetchRequestParams extends Completions.ModelParams { }

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
			const error: Completions.CompletionsFetchFailure = new Completions.UnsuccessfulResponse(
				fetchResponse.val.status,
				fetchResponse.val.statusText,
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

			const response = await this.fetcherService.fetch(url, {
				headers: options.headers,
				body: options.body,
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
					return Result.error(new Completions.QuotaExceeded());
				}

				return Result.error(new Completions.UnsuccessfulResponse(response.status, response.statusText));
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
					const error = errors.fromUnknown(err);
					emitter.reject(error);
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
