/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Result } from '../../../util/common/result';
import { AsyncIterableObject, DeferredPromise } from '../../../util/vs/base/common/async';
import { safeStringify } from '../../../util/vs/base/common/objects';
import { assertType } from '../../../util/vs/base/common/types';
import { Completion } from './completionsAPI';

export class ResponseStream {
	/**
	 * A promise that resolves to the array of completions that were emitted by the stream.
	 *
	 * (it's expected to not throw)
	 */
	public readonly aggregatedStream: Promise<Result<Completion[], Error>>;

	/**
	 * A completion that aggregates completions stream.
	 *
	 * (it's expected to not throw)
	 */
	public readonly response: Promise<Result<Completion, Error>>;

	/**
	 * The stream of completions that were emitted by the response.
	 *
	 * @throws {Error} if the response stream throws an error.
	 */
	public readonly stream: AsyncIterableObject<Completion>;

	constructor(stream: AsyncIterable<Completion>) {
		const tokensDeferredPromise = new DeferredPromise<Result<Completion[], Error>>();
		this.aggregatedStream = tokensDeferredPromise.p;
		this.response = this.aggregatedStream.then((completions) => {
			if (completions.isError()) {
				return completions;
			}
			try {
				return Result.ok(ResponseStream.aggregateCompletionsStream(completions.val));
			} catch (err) {
				return Result.error(err);
			}
		});

		this.stream = new AsyncIterableObject(async (emitter) => {
			const completions: Completion[] = [];
			let error: Error | undefined;
			try {
				for await (const completion of stream) {
					completions.push(completion);
					emitter.emitOne(completion);
				}
			} catch (e) {
				if (e instanceof Error) {
					error = e;
				} else {
					error = new Error(safeStringify(e));
				}
				emitter.reject(e);
			} finally {
				tokensDeferredPromise.complete(
					error ? Result.error(error) : Result.ok(completions)
				);
			}
		});
	}

	private static aggregateCompletionsStream(stream: Completion[]): Completion {
		let text = '';
		let finishReason: Completion.FinishReason | null = null;
		let aggregatedLogsProbs: Completion.LogProbs | null = null;
		let aggregatedUsage: Completion.Usage | undefined = undefined;

		for (const completion of stream) {
			const choice = completion.choices[0]; // TODO@ulugbekna: we only support choice.index=0
			text += choice.text ?? '';
			if (choice.logprobs) {
				if (aggregatedLogsProbs === null) {
					aggregatedLogsProbs = {
						tokens: [...choice.logprobs.tokens],
						token_logprobs: [...choice.logprobs.token_logprobs],
						text_offset: [...choice.logprobs.text_offset],
						top_logprobs: [...choice.logprobs.top_logprobs],
					};
				} else {
					aggregatedLogsProbs.tokens.push(...choice.logprobs.tokens);
					aggregatedLogsProbs.token_logprobs.push(...choice.logprobs.token_logprobs);
					aggregatedLogsProbs.text_offset.push(...choice.logprobs.text_offset);
					aggregatedLogsProbs.top_logprobs.push(...choice.logprobs.top_logprobs);
				}
			}
			if (completion.usage) {
				if (aggregatedUsage === undefined) {
					aggregatedUsage = {
						completion_tokens: completion.usage.completion_tokens,
						prompt_tokens: completion.usage.prompt_tokens,
						total_tokens: completion.usage.total_tokens,
						completion_tokens_details: {
							audio_tokens: completion.usage.completion_tokens_details.audio_tokens,
							reasoning_tokens: completion.usage.completion_tokens_details.reasoning_tokens,
						},
						prompt_tokens_details: {
							audio_tokens: completion.usage.prompt_tokens_details.audio_tokens,
							reasoning_tokens: completion.usage.prompt_tokens_details.reasoning_tokens,
						}
					};
				} else {
					aggregatedUsage.completion_tokens += completion.usage.completion_tokens;
					aggregatedUsage.prompt_tokens += completion.usage.prompt_tokens;
					aggregatedUsage.total_tokens += completion.usage.total_tokens;
					aggregatedUsage.completion_tokens_details.audio_tokens += completion.usage.completion_tokens_details.audio_tokens;
					aggregatedUsage.completion_tokens_details.reasoning_tokens += completion.usage.completion_tokens_details.reasoning_tokens;
					aggregatedUsage.prompt_tokens_details.audio_tokens += completion.usage.prompt_tokens_details.audio_tokens;
					aggregatedUsage.prompt_tokens_details.reasoning_tokens += completion.usage.prompt_tokens_details.reasoning_tokens;
				}
			}
			if (choice.finish_reason) {
				assertType(
					finishReason === null,
					'cannot already have finishReason if just seeing choice.finish_reason'
				);
				finishReason = choice.finish_reason;
			}
		}

		if (stream.length === 0) {
			throw new Error(`Response is empty!`);
		}

		const completion = stream[0];

		const choice: Completion.Choice = {
			index: 0,
			finish_reason: finishReason,
			logprobs: aggregatedLogsProbs,
			text,
		};

		const aggregatedCompletion: Completion = {
			choices: [choice],
			system_fingerprint: completion.system_fingerprint,
			object: completion.object,
			usage: aggregatedUsage,
		};

		return aggregatedCompletion;
	}
}
