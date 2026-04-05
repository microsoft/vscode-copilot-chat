/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { AsyncIterableObject, AsyncIterableSource, DeferredPromise } from '../../../util/vs/base/common/async';
import { Event } from '../../../util/vs/base/common/event';
import { FinishedCallback, IResponseDelta, OptionalChatRequestParams } from '../../networking/common/fetch';
import { IChatEndpoint, IMakeChatRequestOptions } from '../../networking/common/networking';
import { ChatFetchError, ChatFetchResponseType, ChatResponse, ChatResponses } from './commonTypes';

export interface Source {
	readonly extensionId?: string;
}

export interface IResponsePart {
	readonly delta: IResponseDelta;
}

export interface IFetchMLOptions extends IMakeChatRequestOptions {
	endpoint: IChatEndpoint;
	requestOptions: OptionalChatRequestParams;
}


export const IChatMLFetcher = createServiceIdentifier<IChatMLFetcher>('IChatMLFetcher');

export interface IChatMLFetcher {

	readonly _serviceBrand: undefined;

	readonly onDidMakeChatMLRequest: Event<{ readonly model: string; readonly source?: Source; readonly tokenCount?: number }>;

	fetchOne(options: IFetchMLOptions, token: CancellationToken): Promise<ChatResponse>;

	/**
	 * Note: the returned array of strings may be less than `n` (e.g., in case there were errors during streaming)
	 */
	fetchMany(options: IFetchMLOptions, token: CancellationToken): Promise<ChatResponses>;
}

interface IResponsePartWithText extends IResponsePart {
	readonly text: string;
}

export class FetchStreamSource {

	private _stream = new AsyncIterableSource<IResponsePart>();
	private _paused?: (IResponsePartWithText | undefined)[];

	// This means that we will only show one instance of each annotation type, but the IDs are not correct and there is no other way
	private _seenAnnotationTypes = new Set<string>();

	public get stream(): AsyncIterableObject<IResponsePart> {
		return this._stream.asyncIterable;
	}

	constructor() { }

	pause() {
		this._paused ??= [];
	}

	unpause() {
		const toEmit = this._paused;
		if (!toEmit) {
			return;
		}

		this._paused = undefined;
		for (const part of toEmit) {
			if (part) {
				this.update(part.text, part.delta);
			} else {
				this.resolve();
			}
		}
	}

	update(text: string, delta: IResponseDelta): void {
		if (this._paused) {
			this._paused.push({ text, delta });
			return;
		}

		if (delta.codeVulnAnnotations) {
			// We can only display vulnerabilities inside codeblocks, and it's ok to discard annotations that fell outside of them
			const numTripleBackticks = text.match(/(^|\n)```/g)?.length ?? 0;
			const insideCodeblock = numTripleBackticks % 2 === 1;
			if (!insideCodeblock || text.match(/(^|\n)```\w*\s*$/)) { // Not inside a codeblock, or right on the start triple-backtick of a codeblock
				delta.codeVulnAnnotations = undefined;
			}
		}

		if (delta.codeVulnAnnotations) {
			delta.codeVulnAnnotations = delta.codeVulnAnnotations.filter(annotation => !this._seenAnnotationTypes.has(annotation.details.type));
			delta.codeVulnAnnotations.forEach(annotation => this._seenAnnotationTypes.add(annotation.details.type));
		}
		this._stream.emitOne({ delta });
	}

	resolve(): void {
		if (this._paused) {
			this._paused.push(undefined);
			return;
		}

		this._stream.resolve();
	}
}

export class FetchStreamRecorder {
	public readonly callback: FinishedCallback;
	public readonly deltas: IResponseDelta[] = [];

	// TTFTe
	private _firstTokenEmittedTime: number | undefined;
	public get firstTokenEmittedTime(): number | undefined {
		return this._firstTokenEmittedTime;
	}

	constructor(
		callback: FinishedCallback | undefined
	) {
		this.callback = async (text: string, index: number, delta: IResponseDelta): Promise<number | undefined> => {
			if (this._firstTokenEmittedTime === undefined && (delta.text || delta.beginToolCalls || (typeof delta.thinking?.text === 'string' && delta.thinking?.text || delta.thinking?.text?.length) || delta.copilotToolCalls || delta.copilotToolCallStreamUpdates)) {
				this._firstTokenEmittedTime = Date.now();
			}

			const result = callback ? await callback(text, index, delta) : undefined;
			this.deltas.push(delta);
			return result;
		};
	}
}

/**
 * Creates a utility to detect if a streaming chat request fails before the first token is received.
 *
 * This is useful for handling HTTP errors (such as 404) that occur before any streaming data is
 * returned. The utility works by racing the fetch result promise against a signal that resolves
 * when the first streaming token arrives.
 *
 * Usage:
 * ```typescript
 * const { wrapFinishedCb, getInitialFetchError } = createInitialFetchErrorDetector();
 *
 * const fetchResultPromise = endpoint.makeChatRequest2({
 *   ...,
 *   finishedCb: wrapFinishedCb(myFinishedCb),
 * }, token);
 *
 * const initialError = await getInitialFetchError(fetchResultPromise);
 * if (initialError) {
 *   // handle early fetch failure (e.g., 404, rate limit)
 * }
 * ```
 */
export function createInitialFetchErrorDetector(): {
	readonly wrapFinishedCb: (cb: FinishedCallback | undefined) => FinishedCallback;
	readonly getInitialFetchError: (fetchResultPromise: Promise<ChatResponse>) => Promise<ChatFetchError | undefined>;
} {
	const firstTokenReceived = new DeferredPromise<void>();

	return {
		wrapFinishedCb(cb: FinishedCallback | undefined): FinishedCallback {
			return async (text: string, index: number, delta: IResponseDelta): Promise<number | undefined> => {
				if (!firstTokenReceived.isSettled) {
					firstTokenReceived.complete();
				}
				return cb ? cb(text, index, delta) : undefined;
			};
		},

		async getInitialFetchError(fetchResultPromise: Promise<ChatResponse>): Promise<ChatFetchError | undefined> {
			// Race: if the first token arrives before the fetch settles, streaming started OK.
			// If the fetch settles first with an error, we catch it early before any tokens arrive.
			const result = await Promise.race([firstTokenReceived.p, fetchResultPromise]);

			// `firstTokenReceived.p` resolves to `undefined` (void) — no early error.
			// `fetchResultPromise` resolves to a `ChatResponse`; only an error response is returned.
			if (result !== undefined && result.type !== ChatFetchResponseType.Success) {
				return result;
			}
			return undefined;
		},
	};
}
