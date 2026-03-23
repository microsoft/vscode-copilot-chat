/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Normalizes an abort reason into a proper Error.
 * If the reason is already an Error, returns it as-is; otherwise wraps it in
 * a DOMException with `name === 'AbortError'`.
 */
function normalizeAbortReason(reason: unknown): Error {
	if (reason instanceof Error) {
		return reason;
	}
	const message = typeof reason === 'string' ? reason : 'The operation was aborted.';
	return new DOMException(message, 'AbortError');
}

/**
 * Throws a normalized AbortError if the given signal is already aborted.
 * Unlike `signal.throwIfAborted()`, this ensures the thrown value is always
 * an Error with `name === 'AbortError'`, so downstream `isAbortError` checks
 * work reliably even when `signal.reason` is a non-Error value.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) {
		return;
	}
	throw normalizeAbortReason(signal.reason);
}

/**
 * Sleep that also respects an optional AbortSignal.
 * If the signal is already aborted, rejects immediately.
 * If the signal is aborted during the sleep, rejects with the abort reason.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	throwIfAborted(signal);
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(normalizeAbortReason(signal.reason));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
