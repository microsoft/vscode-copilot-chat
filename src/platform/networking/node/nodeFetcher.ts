/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { IEnvService } from '../../env/common/envService';
import { FetchOptions, IAbortController, IHeaders, Response } from '../common/fetcherService';
import { IFetcher, userAgentLibraryHeader } from '../common/networking';

export class NodeFetcher implements IFetcher {

	constructor(
		private readonly _envService: IEnvService,

		private readonly _userAgentLibraryUpdate?: (original: string) => string,
	) {
	}

	getUserAgentLibrary(): string {
		return 'node-http';
	}

	fetch(url: string, options: FetchOptions): Promise<Response> {
		const headers = { ...options.headers };
		headers['User-Agent'] = `GitHubCopilotChat/${this._envService.getVersion()}`;
		headers[userAgentLibraryHeader] = this._userAgentLibraryUpdate ? this._userAgentLibraryUpdate(this.getUserAgentLibrary()) : this.getUserAgentLibrary();

		let body = options.body;
		if (options.json) {
			if (options.body) {
				throw new Error(`Illegal arguments! Cannot pass in both 'body' and 'json'!`);
			}
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(options.json);
		}

		const method = options.method || 'GET';
		if (method !== 'GET' && method !== 'POST') {
			throw new Error(`Illegal arguments! 'method' must be either 'GET' or 'POST'!`);
		}

		const signal = options.signal ?? new AbortController().signal;
		if (signal && !(signal instanceof AbortSignal)) {
			throw new Error(`Illegal arguments! 'signal' must be an instance of AbortSignal!`);
		}

		return this._fetch(url, method, headers, body, signal);
	}

	private _fetch(url: string, method: 'GET' | 'POST', headers: { [name: string]: string }, body: string | undefined, signal: AbortSignal): Promise<Response> {
		return new Promise((resolve, reject) => {
			const module = url.startsWith('https:') ? https : http;
			const req = module.request(url, { method, headers }, res => {
				if (signal.aborted) {
					res.destroy();
					req.destroy();
					reject(makeAbortError(signal));
					return;
				}

				const nodeFetcherResponse = new NodeFetcherResponse(req, res, signal);
				resolve(new Response(
					res.statusCode || 0,
					res.statusMessage || '',
					nodeFetcherResponse.headers,
					async () => nodeFetcherResponse.text(),
					async () => nodeFetcherResponse.json(),
					async () => nodeFetcherResponse.body(),
				));
			});
			req.setTimeout(60 * 1000); // time out after 60s of receiving no data
			req.on('error', reject);

			if (body) {
				req.write(body);
			}
			req.end();
		});
	}
	async disconnectAll(): Promise<void> {
		// Nothing to do
	}
	makeAbortController(): IAbortController {
		return new AbortController();
	}
	isAbortError(e: any): boolean {
		return isAbortError(e);
	}
	isInternetDisconnectedError(_e: any): boolean {
		return false;
	}
	isFetcherError(e: any): boolean {
		return e && ['EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'].includes(e.code);
	}
	getUserMessageForFetcherError(err: any): string {
		return `Please check your firewall rules and network connection then try again. Error Code: ${err.code}.`;
	}
}

function makeAbortError(signal: AbortSignal): Error {
	// see https://github.com/nodejs/node/issues/38361#issuecomment-1683839467
	return signal.reason;
}
function isAbortError(e: any): boolean {
	// see https://github.com/nodejs/node/issues/38361#issuecomment-1683839467
	return e && e.name === "AbortError";
}

class NodeFetcherResponse {

	readonly headers: IHeaders;

	constructor(
		readonly req: http.ClientRequest,
		readonly res: http.IncomingMessage,
		readonly signal: AbortSignal
	) {
		this.headers = new class implements IHeaders {
			get(name: string): string | null {
				const result = res.headers[name];
				return Array.isArray(result) ? result[0] : result ?? null;
			}
			[Symbol.iterator](): Iterator<[string, string], any, undefined> {
				const keys = Object.keys(res.headers);
				let index = 0;
				return {
					next: (): IteratorResult<[string, string]> => {
						if (index >= keys.length) {
							return { done: true, value: undefined };
						}
						const key = keys[index++];
						return { done: false, value: [key, this.get(key)!] };
					}
				};
			}
		};
	}

	public text(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			this.res.on('data', chunk => chunks.push(chunk));
			this.res.on('end', () => resolve(Buffer.concat(chunks).toString()));
			this.res.on('error', reject);
			this.signal.addEventListener('abort', () => {
				this.res.destroy();
				this.req.destroy();
				reject(makeAbortError(this.signal));
			});
		});
	}

	public async json(): Promise<any> {
		const text = await this.text();
		return JSON.parse(text);
	}

	public async body(): Promise<NodeJS.ReadableStream | null> {
		this.signal.addEventListener('abort', () => {
			this.res.emit('error', makeAbortError(this.signal));
			this.res.destroy();
			this.req.destroy();
		});
		return this.res;
	}
}
