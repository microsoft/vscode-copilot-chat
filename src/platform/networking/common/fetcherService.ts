/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';

export const IFetcherService = createServiceIdentifier<IFetcherService>('IFetcherService');

export interface IFetcherService {
	readonly _serviceBrand: undefined;
	getUserAgentLibrary(): string;
	fetch(url: string, options: FetchOptions): Promise<Response>;
	disconnectAll(): Promise<unknown>;
	makeAbortController(): IAbortController;
	isAbortError(e: any): boolean;
	isInternetDisconnectedError(e: any): boolean;
	isFetcherError(e: any): boolean;
	getUserMessageForFetcherError(err: any): string;
}

/** A basic version of http://developer.mozilla.org/en-US/docs/Web/API/Response */
export class Response {
	ok = this.status >= 200 && this.status < 300;
	constructor(
		readonly status: number,
		readonly statusText: string,
		readonly headers: IHeaders,
		private readonly getText: () => Promise<string>,
		private readonly getJson: () => Promise<any>,
		private readonly getBody: () => Promise<unknown | null>
	) { }

	async text(): Promise<string> {
		return this.getText();
	}

	async json(): Promise<any> {
		return this.getJson();
	}

	/** Async version of the standard .body field. */
	async body(): Promise<unknown | null> {
		return this.getBody();
	}
}

/** These are the options we currently use, for ease of reference. */
export interface FetchOptions {
	headers?: { [name: string]: string };
	body?: string;
	timeout?: number;
	json?: any;
	method?: 'GET' | 'POST';
	signal?: IAbortSignal;
	verifyJSONAndRetry?: boolean;
}

export interface IAbortSignal {
	readonly aborted: boolean;
	addEventListener(type: 'abort', listener: (this: AbortSignal) => void): void;
	removeEventListener(type: 'abort', listener: (this: AbortSignal) => void): void;
}

export interface IAbortController {
	readonly signal: IAbortSignal;
	abort(): void;
}

export interface IHeaders extends Iterable<[string, string]> {
	get(name: string): string | null;
}

export async function jsonVerboseError(resp: Response) {
	const text = await resp.text();
	try {
		return JSON.parse(text);
	} catch (err) {
		const lines = text.split('\n');
		const errText = lines.length > 50 ? [...lines.slice(0, 25), '[...]', ...lines.slice(lines.length - 25)].join('\n') : text;
		err.message = `${err.message}. Response: ${errText}`;
		throw err;
	}
}
