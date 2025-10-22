/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FetchOptions, Fetcher, IAbortController, IHeaders, Response } from '../networking';
import { CopilotNamedAnnotationList } from '../openai/stream';
import { Readable } from 'stream';

type HeadersParameter = { [key: string]: string };

export function createFakeResponse(statusCode: number, response?: string, headers?: HeadersParameter) {
	const fakeHeaders = new FakeHeaders();
	fakeHeaders.set('x-github-request-id', '1');
	for (const [key, value] of Object.entries(headers || {})) {
		fakeHeaders.set(key, value);
	}
	return new Response(
		statusCode,
		'status text',
		fakeHeaders,
		() => Promise.resolve(response ?? ''),
		() => Promise.resolve(response ? JSON.parse(response) : {}),
		() => Promise.resolve(null)
	);
}

export function createFakeJsonResponse(statusCode: number, response: string | object, headers?: HeadersParameter) {
	let text: string;
	if (typeof response === 'string') {
		text = response;
	} else {
		text = JSON.stringify(response);
	}
	return createFakeResponse(statusCode, text, Object.assign({ 'content-type': 'application/json' }, headers));
}

export function createFakeStreamResponse(body: string): Response {
	return new Response(
		200,
		'Success',
		new FakeHeaders(),
		() => Promise.resolve(body),
		() => Promise.resolve(JSON.parse(body.replace(/^data: /gm, '').replace(/\n\[DONE\]\n$/, ''))),
		() => Promise.resolve(toStream(body))
	);
}

export function createFakeCompletionResponse(
	completionText: string | string[],
	options?: { annotations?: CopilotNamedAnnotationList }
): Response {
	const now = Math.floor(Date.now() / 1000);
	if (typeof completionText === 'string') {
		completionText = [completionText];
	}
	const choices = completionText.map((text, i) => ({
		text,
		index: i,
		finishReason: 'stop',
		logprobs: null,
		copilot_annotations: options?.annotations,
		p: 'aaaaaa',
	}));
	const responseObject = {
		id: 'cmpl-AaZz1234',
		created: now,
		model: 'unit-test',
		choices,
	};
	const responseLines = [JSON.stringify(responseObject), `[DONE]`];
	return createFakeStreamResponse(responseLines.map(l => `data: ${l}\n`).join(''));
}

export function fakeCodeReference(
	startOffset: number = 0,
	stopOffset: number = 1,
	license: string = 'MIT',
	url: string = 'https://github.com/github/example'
): CopilotNamedAnnotationList {
	return {
		ip_code_citations: [
			{
				id: 5,
				start_offset: startOffset,
				stop_offset: stopOffset,
				details: {
					citations: [
						{
							url,
							license,
						},
					],
				},
			},
		],
	};
}

export abstract class FakeFetcher extends Fetcher {
	override readonly name: string = 'FakeFetcher';
	disconnectAll(): Promise<unknown> {
		throw new Error('Method not implemented.');
	}
}

type FakeResponseGenerator = (url: string, options: FetchOptions) => Response | Promise<Response>;
const SuccessResponseGenerator: FakeResponseGenerator = () => createFakeResponse(200);

export class StaticFetcher extends FakeFetcher {
	constructor(private createResponse: FakeResponseGenerator = SuccessResponseGenerator) {
		super();
	}

	headerBuffer: { [name: string]: string } | undefined;

	fetch(url: string, options: FetchOptions): Promise<Response> {
		this.headerBuffer = options.headers;
		return Promise.resolve(this.createResponse(url, options));
	}
}

export class NoFetchFetcher extends FakeFetcher {
	fetch(url: string, options: FetchOptions): Promise<Response> {
		throw new Error('NoFetchFetcher does not support fetching');
	}
}

function toStream(...strings: string[]): NodeJS.ReadableStream {
	const stream = new Readable();
	stream._read = () => { };
	for (const s of strings) {
		stream.push(s);
	}
	stream.push(null);
	return stream;
}

class FakeHeaders implements IHeaders {
	private readonly headers: Map<string, string> = new Map();

	append(name: string, value: string): void {
		this.headers.set(name.toLowerCase(), value);
	}
	delete(name: string): void {
		this.headers.delete(name.toLowerCase());
	}
	get(name: string): string | null {
		return this.headers.get(name.toLowerCase()) ?? null;
	}
	has(name: string): boolean {
		return this.headers.has(name.toLowerCase());
	}
	set(name: string, value: string): void {
		this.headers.set(name.toLowerCase(), value);
	}
	entries(): Iterator<[string, string]> {
		return this.headers.entries();
	}
	keys(): Iterator<string> {
		return this.headers.keys();
	}
	values(): Iterator<string> {
		return this.headers.values();
	}
	[Symbol.iterator](): Iterator<[string, string]> {
		return this.headers.entries();
	}
}

export class FakeAbortController implements IAbortController {
	readonly signal = { aborted: false, addEventListener: () => { }, removeEventListener: () => { } };
	abort(): void {
		this.signal.aborted = true;
	}
}
