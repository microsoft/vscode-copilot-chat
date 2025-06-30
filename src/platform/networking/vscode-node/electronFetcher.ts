/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvService } from '../../env/common/envService';
import { BaseFetchFetcher } from '../node/baseFetchFetcher';

export class ElectronFetcher extends BaseFetchFetcher {

	public static create(envService: IEnvService, userAgentLibraryUpdate?: (original: string) => string): ElectronFetcher | null {
		const net = loadNetModule();
		if (!net) {
			return null;
		}
		return new ElectronFetcher(net.fetch, envService, userAgentLibraryUpdate);
	}

	getUserAgentLibrary(): string {
		return 'electron-fetch';
	}

	isInternetDisconnectedError(e: any): boolean {
		return ['net::ERR_INTERNET_DISCONNECTED'].includes(e?.message);
	}
	isFetcherError(e: any): boolean {
		return e && e.message && e.message.startsWith('net::');
	}
}

function loadNetModule(): typeof import('electron').net | undefined {
	try {
		return require('electron').net;
	} catch (err) { }

	return undefined;
}
