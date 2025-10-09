/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { Embedding, EmbeddingType } from '../../../../platform/embeddings/common/embeddingsComputer';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { RunOnceScheduler } from '../../../../util/vs/base/common/async';
import { StringSHA1 } from '../../../../util/vs/base/common/hash';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { LRUCache } from '../../../../util/vs/base/common/map';
import { URI } from '../../../../util/vs/base/common/uri';
import { IToolEmbeddingsCache } from './toolEmbeddingsComputer';

interface IStoredData {
	version: 1;
	entries: [string, Embedding][];
}

const EMBEDDING_CACHE_FILE_NAME = 'toolEmbeddingsCache.json';

export class ToolEmbeddingLocalCache extends Disposable implements IToolEmbeddingsCache {
	private readonly _storageUri: URI;
	private readonly _lru = new LRUCache<string, Embedding>(1000);
	private readonly _toolHashes = new WeakMap<LanguageModelToolInformation, string>();
	private readonly _storageScheduler = this._register(new RunOnceScheduler(() => this._save(), 5000));

	constructor(
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IVSCodeExtensionContext _context: IVSCodeExtensionContext,
	) {
		super();
		this._storageUri = URI.joinPath(_context.globalStorageUri, EMBEDDING_CACHE_FILE_NAME);
	}

	public async initialize(): Promise<void> {
		try {
			const data = new TextDecoder().decode(await this._fileSystemService.readFile(this._storageUri, true));
			const stored: IStoredData = JSON.parse(data);
			if (stored.version !== 1) {
				return;
			}

			for (const [key, value] of stored.entries) {
				this._lru.set(key, {
					type: new EmbeddingType(value.type.id),
					value: value.value,
				});
			}
		} catch {
			// ignored
		}
	}

	public get(tool: LanguageModelToolInformation): Embedding | undefined {
		return this._lru.get(this._getKey(tool));
	}

	public set(tool: LanguageModelToolInformation, embedding: Embedding): void {
		const key = this._getKey(tool);
		this._lru.set(key, embedding);
		this._storageScheduler.schedule();
	}

	private _getKey(tool: LanguageModelToolInformation): string {
		let hash = this._toolHashes.get(tool);
		if (!hash) {
			const sha = new StringSHA1();
			sha.update(tool.name);
			sha.update('\0');
			sha.update(tool.description);
			hash = sha.digest();
			this._toolHashes.set(tool, hash);
		}

		return hash;
	}

	private _save() {
		if (!this._lru.size) {
			return;
		}

		const data: IStoredData = {
			version: 1,
			entries: this._lru.toJSON(),
		};

		const content = new TextEncoder().encode(JSON.stringify(data));
		this._fileSystemService.writeFile(this._storageUri, content);
	}
}

