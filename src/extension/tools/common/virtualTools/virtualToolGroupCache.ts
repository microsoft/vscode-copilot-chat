/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { encodeBase64, VSBuffer } from '../../../../util/vs/base/common/buffer';
import { LRUCache } from '../../../../util/vs/base/common/map';
import { LanguageModelToolInformation } from '../../../../vscodeTypes';
import { ISummarizedToolCategory, IToolGroupingCache } from './virtualToolTypes';

const GROUP_CACHE_SIZE = 128;
const GROUP_CACHE_NAME = 'virtToolGroupCache';

interface CachedValue {
	groups: {
		summary: string;
		name: string;
		tools: string[];
	}[];
}

interface StoredValue {
	lru: [string, CachedValue][];
}

export class ToolGroupingCache implements IToolGroupingCache {
	declare readonly _serviceBrand: undefined;

	private readonly _value = new LRUCache<string, CachedValue>(GROUP_CACHE_SIZE);
	private readonly _inFlight = new Map<string, Promise<ISummarizedToolCategory[] | undefined>>();
	private _changed = false;

	constructor(
		@IVSCodeExtensionContext private readonly _extContext: IVSCodeExtensionContext,
	) {
		const cached = _extContext.globalState.get<StoredValue>(GROUP_CACHE_NAME);
		if (cached) {
			try {
				cached.lru.forEach(([k, v]) => this._value.set(k, v));
			} catch (e) {
				// ignored
			}
		}
	}

	public async clear() {
		this._changed = false;
		this._value.clear();
		this._inFlight.clear();
		await this._extContext.globalState.update(GROUP_CACHE_NAME, undefined);
	}

	public async flush() {
		if (!this._changed) {
			return Promise.resolve();
		}

		this._changed = false;
		const value: StoredValue = {
			lru: this._value.toJSON(),
		};

		await this._extContext.globalState.update(GROUP_CACHE_NAME, value);
	}

	public async getOrInsert(tools: LanguageModelToolInformation[], factory: () => Promise<ISummarizedToolCategory[] | undefined>): Promise<ISummarizedToolCategory[] | undefined> {
		const key = await this.getKey(tools);

		const existing = this._value.get(key);
		if (existing) {
			this._changed = true;
			return this.hydrate(tools, existing);
		}

		const promise = this._inFlight.get(key) || factory().then(result => {
			if (result) {
				this._changed = true;
				this._value.set(key, {
					groups: result.map(g => ({
						summary: g.summary,
						name: g.name,
						tools: g.tools.map(t => t.name),
					})),
				});
			}

			return result;
		}).finally(() => {
			this._inFlight.delete(key);
		});

		this._inFlight.set(key, promise);

		return promise;
	}

	private hydrate(tools: LanguageModelToolInformation[], { groups }: CachedValue): ISummarizedToolCategory[] {
		return groups.map(g => ({
			summary: g.summary,
			name: g.name,
			tools: tools.filter(t => g.tools.includes(t.name)),
		}));
	}

	private async getKey(tools: LanguageModelToolInformation[]): Promise<string> {
		const str = tools.map(t => t.name + '\0' + t.description).sort().join(',');
		const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
		return encodeBase64(VSBuffer.wrap(new Uint8Array(hashBuf)));
	}
}
