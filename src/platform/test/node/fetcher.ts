/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { IHeaders, Response } from '../../networking/common/fetcherService';


export function createFakeResponse(statusCode: number, response: any = 'body') {
	return new Response(
		statusCode,
		'status text',
		new FakeHeaders(),
		() => Promise.resolve(JSON.stringify(response)),
		() => Promise.resolve(response),
		async () => null
	);
}

export function createFakeStreamResponse(body: string | string[] | { chunk: string; shouldCancelStream: boolean }[], cts?: CancellationTokenSource): Response {
	const chunks = Array.isArray(body) ? body : [body];
	return new Response(
		200,
		'Success',
		new FakeHeaders(),
		async () => chunks.join(''),
		async () => null,
		async () => toStream(chunks, cts)
	);
}

function toStream(strings: string[] | { chunk: string; shouldCancelStream: boolean }[], cts?: CancellationTokenSource): NodeJS.ReadableStream {
	if (strings.length === 0 || typeof strings[0] === 'string') {
		const stream = new Readable();
		stream._read = () => { };
		for (const s of strings) {
			stream.push(s);
		}
		stream.push(null);
		return stream;
	} else {
		return Readable.from(function* yieldingStreamOfStringChunksWithCancellation() {
			for (const s of strings) {
				if (typeof s === 'string') {
					yield s;
				} else {
					yield s.chunk;
					if (s.shouldCancelStream) {
						cts?.cancel();
					}
				}
			}
		}());
	}
}

export class FakeHeaders implements IHeaders {
	private readonly headers: Map<string, string> = new Map();

	get(name: string): string | null {
		return this.headers.get(name) ?? null;
	}
	[Symbol.iterator](): Iterator<[string, string]> {
		return this.headers.entries();
	}
}
