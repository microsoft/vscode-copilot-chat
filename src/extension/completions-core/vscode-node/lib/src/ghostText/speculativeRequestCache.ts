/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { LRUCacheMap } from '../helpers/cache';

type RequestFunction = () => Promise<unknown>;

export class SpeculativeRequestCache {
	private cache = new LRUCacheMap<string, RequestFunction>(100);

	set(completionId: string, requestFunction: RequestFunction): void {
		this.cache.set(completionId, requestFunction);
	}

	async request(completionId: string): Promise<void> {
		const fn = this.cache.get(completionId);
		if (fn === undefined) { return; }
		this.cache.delete(completionId);
		await fn();
	}
}
