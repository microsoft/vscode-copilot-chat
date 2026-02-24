/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as undici from 'undici';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IEnvService } from '../../env/common/envService';
import { ReportFetchEvent } from '../common/fetcherService';
import { BaseFetchFetcher } from './baseFetchFetcher';

export class NodeFetchFetcher extends BaseFetchFetcher {

	static readonly ID = 'node-fetch' as const;

	constructor(
		envService: IEnvService,
		reportEvent: ReportFetchEvent = () => { },
		userAgentLibraryUpdate?: (original: string) => string,
	) {
		super(getFetch(), envService, NodeFetchFetcher.ID, reportEvent, userAgentLibraryUpdate);
	}

	getUserAgentLibrary(): string {
		return NodeFetchFetcher.ID;
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
		return fetch(input, { dispatcher: agent.value, ...init });
	};
}

// Cache agent to reuse connections.
const agent = new Lazy(() => new undici.Agent({ allowH2: true }));
