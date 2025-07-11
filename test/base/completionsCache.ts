/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { FetchResponse } from '../../src/platform/nesFetch/node/completionsFetchServiceImpl';
import { Lock } from '../../src/util/common/lock';
import { AsyncIterableObject } from '../../src/util/vs/base/common/async';
import { BugIndicatingError } from '../../src/util/vs/base/common/errors';
import { LRUCache } from '../../src/util/vs/base/common/map';
import { SQLiteSlottedCache } from './cache';
import { CachedResponseMetadata } from './cachingChatMLFetcher';
import { CacheableCompletionRequest } from './cachingCompletionsFetchService';
import { readFileIfExists } from './fileUtils';
import { CurrentTestRunInfo } from './simulationContext';

export interface ICacheableCompletionsResponse {
	readonly requestId: string;
	readonly cacheMetadata: CachedResponseMetadata;
	readonly status: number;
	readonly statusText: string;
	readonly body: string;
}

export namespace ICacheableCompletionsResponse {

	export function create(requestId: string, cacheMetadata: CachedResponseMetadata, status: number, statusText: string, body: string): ICacheableCompletionsResponse {
		return { requestId, cacheMetadata, status, statusText, body };
	}

	export function isICacheableResponse(obj: unknown): obj is ICacheableCompletionsResponse {
		return (
			typeof obj === 'object' &&
			obj !== null &&
			'requestId' in obj &&
			typeof (obj as any).requestId === 'string' &&
			'cacheMetadata' in obj &&
			CachedResponseMetadata.isCachedResponseMetadata((obj as any).cacheMetadata) &&
			'status' in obj &&
			typeof (obj as any).status === 'number' &&
			'statusText' in obj &&
			typeof (obj as any).statusText === 'string' &&
			'body' in obj &&
			typeof (obj as any).body === 'string'
		);
	}

	export function toFetchResponse(v: ICacheableCompletionsResponse): FetchResponse {
		// @ulugbekna: currently, if we don't chunk up, the streaming logic errors out if the stream eventually errored (eg "response too long"),
		// 	but we want to be able to capture edits proposed before the error
		const bodyStream = stringToChunkedStream(v.body, 512 /* arbitrary chunk size to hit fast/correct balance */);

		return {
			status: v.status,
			statusText: v.statusText,
			body: bodyStream,
			headers: {} // @ulugbekna: we don't use headers, so this should be ok for now
		};
	}

	function stringToChunkedStream(str: string, chunkSize: number) {
		return new AsyncIterableObject<string>(emitter => {
			for (let i = 0; i < str.length; i += chunkSize) {
				emitter.emitOne(str.slice(i, i + chunkSize));
			}
		});
	}
}

export interface ICompletionsCache {
	get(req: CacheableCompletionRequest, cacheSlot: number): Promise<ICacheableCompletionsResponse | undefined>;
	set(req: CacheableCompletionRequest, cacheSlot: number, cachedResponse: ICacheableCompletionsResponse): Promise<void>;
}

interface ICacheEntry {
	request: unknown;
	responses: ICacheableCompletionsResponse[];
}

export class CompletionsCache implements ICompletionsCache {

	private static readonly updateLocks = new Map</* full cache path */ string, Lock>();
	private static readonly inMemoryCacheEntries = new LRUCache</* full cache path */ string, ICacheEntry | undefined>(50);

	constructor(private readonly cachePath: string) {
		if (!fs.existsSync(this.cachePath)) {
			fs.mkdirSync(this.cachePath, { recursive: true });
		}
	}

	async get(req: CacheableCompletionRequest, cacheSlot: number) {

		const cachePath = this._getCachePath(req);
		const lock = this.getOrCreateLock(cachePath);
		try {
			await lock.acquire();
			const cacheEntry = await this._getCacheEntry(cachePath);
			const r = cacheEntry?.responses.at(cacheSlot);
			if (!r) {
				return;
			}
			return r;
			// return ICacheableCompletionsResponse.toFetchResponse(r);
		} finally {
			lock.release();
		}
	}

	async set(req: CacheableCompletionRequest, cacheSlot: number, value: ICacheableCompletionsResponse): Promise<void> {

		const cachePath = this._getCachePath(req);
		const lock = this.getOrCreateLock(cachePath);
		try {
			await lock.acquire();
			const cacheEntry = (await this._getCacheEntry(cachePath)) ?? { request: req.toJSON(), responses: [] };
			cacheEntry.responses[cacheSlot] = value;
			CompletionsCache.inMemoryCacheEntries.set(cachePath, cacheEntry);

			const cacheDir = path.dirname(cachePath);
			try {
				await fs.promises.stat(cacheDir);
			} catch (err) {
				await fs.promises.mkdir(cacheDir, { recursive: true });
			}
			await fs.promises.writeFile(cachePath, yaml.stringify(cacheEntry, null, '\t'));
		} finally {
			lock.release();
		}
	}

	private getOrCreateLock(cachePath: string): Lock {
		let lock = CompletionsCache.updateLocks.get(cachePath);
		if (!lock) {
			lock = new Lock();
			CompletionsCache.updateLocks.set(cachePath, lock);
		}
		return lock;
	}

	private _getCachePath(req: CacheableCompletionRequest): string {
		return path.join(this.cachePath, `${req.hash}.yml`);
	}

	private async _getCacheEntry(cachePath: string): Promise<ICacheEntry | undefined> {
		const inMemCacheEntry = CompletionsCache.inMemoryCacheEntries.get(cachePath);
		if (inMemCacheEntry !== undefined) {
			return inMemCacheEntry;
		}
		const cacheContents = await readFileIfExists(cachePath);
		if (cacheContents === undefined) {
			return undefined;
		}
		try {
			const result = yaml.parse(cacheContents) as ICacheEntry;
			CompletionsCache.inMemoryCacheEntries.set(cachePath, result);
			return result;
		} catch (e) {
			console.error(e);
			throw new BugIndicatingError(`Corrupted cache file "${cachePath}": ${e}`);
		}
	}
}

export class CompletionsSQLiteCache extends SQLiteSlottedCache<CacheableCompletionRequest, ICacheableCompletionsResponse> implements ICompletionsCache {
	constructor(salt: string, info: CurrentTestRunInfo) {
		super('completions', salt, info);
	}
}
