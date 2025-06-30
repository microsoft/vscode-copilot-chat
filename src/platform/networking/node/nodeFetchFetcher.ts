/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as undici from 'undici';
import { IEnvService } from '../../env/common/envService';
import { BaseFetchFetcher } from './baseFetchFetcher';

export class NodeFetchFetcher extends BaseFetchFetcher {

	constructor(
		envService: IEnvService,
		userAgentLibraryUpdate?: (original: string) => string,
	) {
		super(getFetch(), envService, userAgentLibraryUpdate);
	}

	getUserAgentLibrary(): string {
		return 'node-fetch';
	}

	isInternetDisconnectedError(_e: any): boolean {
		return false;
	}
	isFetcherError(e: any): boolean {
		const code = e?.code || e?.cause?.code;
		return code && ['EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'].includes(code);
	}
}

function getFetch(): typeof globalThis.fetch {
	const fetch = (globalThis as any).__vscodePatchedFetch || globalThis.fetch;
	return function (input: string | URL | globalThis.Request, init?: RequestInit) {
		return fetch(input, { dispatcher: new undici.Agent({ allowH2: true }), ...init });
	};
}
