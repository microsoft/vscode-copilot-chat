/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sleep that also respects an optional AbortSignal.
 * If the signal is already aborted, rejects immediately.
 * If the signal is aborted during the sleep, rejects with the abort reason.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
