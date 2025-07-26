/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'fs';
import { IDisposable } from 'monaco-editor';
import sql from 'node:sqlite';
import path from 'path';
import { CancelablePromise, ThrottledDelayer, createCancelablePromise, raceTimeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { Schemas } from '../../../util/vs/base/common/network';
import { URI } from '../../../util/vs/base/common/uri';
import { IRange, Range } from '../../../util/vs/editor/common/core/range';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { FileChunk, FileChunkWithEmbedding } from '../../chunking/common/chunk';
import { stripChunkTextMetadata } from '../../chunking/common/chunkingStringUtils';
import { EmbeddingType, EmbeddingVector } from '../../embeddings/common/embeddingsComputer';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { ILogService } from '../../log/common/logService';
import { FileRepresentation, IWorkspaceFileIndex } from './workspaceFileIndex';

interface PersistedCache {
	readonly version: string;
	readonly embeddingModel: string | undefined;
	readonly entries: Record<string, PersistedCacheEntry>;
}

interface PersistedCacheEntry {
	readonly contentVersionId: string | undefined;
	readonly hash: string | undefined;
	readonly entries: readonly {
		readonly text: string;
		readonly range: IRange;
		readonly embedding: EmbeddingVector | /* base64*/ string;
		readonly chunkHash: string | undefined;
	}[];
}

type CacheEntry = {
	readonly contentVersionId: string | undefined;
	readonly fileHash: string | undefined;
	readonly state: 'pending';
	readonly value: CancelablePromise<readonly FileChunkWithEmbedding[] | undefined>;
} | {
	readonly contentVersionId: string | undefined;
	readonly fileHash: string | undefined;
	readonly state: 'resolved' | 'rejected';
	readonly value: readonly FileChunkWithEmbedding[] | undefined;
};


export interface IWorkspaceChunkAndEmbeddingCache extends IDisposable {
	/**
	 * Checks if {@linkcode file} is currently indexed. Does not wait for any current indexing operation to complete.
	 */
	isIndexed(file: FileRepresentation): Promise<boolean>;

	/**
	 * Returns the chunks and embeddings for the given file, or undefined if not available.
	 */
	get(file: FileRepresentation): Promise<readonly FileChunkWithEmbedding[] | undefined>;

	getCurrentChunksForUri(uri: URI): ReadonlyMap<string, FileChunkWithEmbedding> | undefined;

	/**
	 * Updates the cache for the given file by computing the chunks and embeddings.
	 * Returns the updated chunks and embeddings.
	 */
	update(file: FileRepresentation, compute: (token: CancellationToken) => Promise<readonly FileChunkWithEmbedding[] | undefined>): Promise<readonly FileChunkWithEmbedding[] | undefined>;
}

export async function createWorkspaceChunkAndEmbeddingCache(
	accessor: ServicesAccessor,
	embeddingType: EmbeddingType,
	cacheRoot: URI | undefined,
	workspaceIndex: IWorkspaceFileIndex
): Promise<IWorkspaceChunkAndEmbeddingCache> {
	const instantiationService = accessor.get(IInstantiationService);
	if (cacheRoot) {
		const db = await instantiationService.invokeFunction(accessor => DbCache.create(accessor, embeddingType, cacheRoot, workspaceIndex));
		if (db) {
			return db;
		}
	}
	return instantiationService.invokeFunction(accessor => DiskCache.load(accessor, embeddingType, cacheRoot, workspaceIndex));
}

class DiskCache extends Disposable implements IWorkspaceChunkAndEmbeddingCache {
	private static readonly version = '1.0.0';
	private static cacheFileName = 'workspace-chunks.json';

	private static encodeEmbedding(embedding: EmbeddingVector): string {
		const floatArray = Float32Array.from(embedding);
		return Buffer.from(floatArray.buffer).toString('base64');
	}

	public static decodeEmbedding(base64Str: string): EmbeddingVector {
		const decoded = Buffer.from(base64Str, 'base64');
		const float32Array = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / Float32Array.BYTES_PER_ELEMENT);
		return Array.from(float32Array);
	}

	public static async readDiskCache(accessor: ServicesAccessor, embeddingType: EmbeddingType, cacheRoot: URI, logService: ILogService): Promise<Iterable<[string, PersistedCacheEntry]> | undefined> {
		const fileSystem = accessor.get(IFileSystemService);

		const cachePath = URI.joinPath(cacheRoot, DiskCache.cacheFileName);
		try {
			let file: Uint8Array | undefined;
			try {
				file = await fileSystem.readFile(cachePath, true);
			} catch (e) {
				// Expected, most likely file doesn't exist
				return undefined;
			}

			const data: PersistedCache = JSON.parse(new TextDecoder().decode(file));
			if (data.version !== DiskCache.version) {
				logService.debug(`WorkspaceChunkAndEmbeddingCache: invalidating cache due to version mismatch. Expected ${DiskCache.version} but found ${data.version}`);
				return undefined;
			}

			// Check mismatch in embedding models
			// Older cached version don't store their embedding model but it's always text3small_512
			if (
				(data.embeddingModel === undefined && embeddingType !== EmbeddingType.text3small_512)
				|| (data.embeddingModel !== undefined && data.embeddingModel !== embeddingType.id)
			) {
				logService.debug(`WorkspaceChunkAndEmbeddingCache: invalidating cache due to embeddings type mismatch. Expected ${embeddingType} but found ${data.embeddingModel}`);
				return undefined;
			}

			return Object.entries(data.entries);
		} catch {
			return undefined;
		}
	}

	static async deleteDiskCache(accessor: ServicesAccessor, cacheRoot: URI) {
		const fileSystem = accessor.get(IFileSystemService);
		const cachePath = URI.joinPath(cacheRoot, DiskCache.cacheFileName);
		try {
			await fileSystem.delete(cachePath);
		} catch {
			// noop
		}
	}

	static async load(
		accessor: ServicesAccessor,
		embeddingType: EmbeddingType,
		cacheRoot: URI | undefined,
		workspaceIndex: IWorkspaceFileIndex
	): Promise<DiskCache> {
		const fileSystem = accessor.get(IFileSystemService);
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);

		const cachePath = cacheRoot ? URI.joinPath(cacheRoot, DiskCache.cacheFileName) : undefined;
		const cache = new DiskCache(embeddingType, cachePath, workspaceIndex, fileSystem, logService);

		if (cacheRoot && cachePath) {
			await workspaceIndex.initialize();

			const cacheValues = await instantiationService.invokeFunction(accessor => DiskCache.readDiskCache(accessor, embeddingType, cacheRoot, logService));
			if (cacheValues) {
				logService.debug(`Restoring workspace chunk + embeddings cache from ${cachePath.fsPath}`);

				for (const [uriStr, entry] of cacheValues) {
					const docUri = URI.parse(uriStr);
					if (!workspaceIndex.get(docUri)) {
						continue;
					}

					cache._cache.set(docUri, {
						contentVersionId: entry.contentVersionId,
						fileHash: entry.hash,
						state: 'resolved',
						value: entry.entries.map((x): FileChunkWithEmbedding => ({
							embedding: {
								value: typeof x.embedding === 'string' ? DiskCache.decodeEmbedding(x.embedding) : x.embedding,
								type: embeddingType,
							},
							chunkHash: x.chunkHash,
							chunk: {
								file: docUri,
								text: stripChunkTextMetadata(x.text),
								rawText: undefined,
								range: Range.lift(x.range),
							} satisfies FileChunk
						}))
					});
				}
			}
		}

		return cache;
	}

	private readonly _cache = new ResourceMap<CacheEntry>();

	private _isDisposed = false;

	private readonly _writeDelayer = this._register(new ThrottledDelayer<void>(5000));

	private constructor(
		private readonly embeddingType: EmbeddingType,
		private readonly cachePath: URI | undefined,
		@IWorkspaceFileIndex private readonly _workspaceIndex: IWorkspaceFileIndex,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(this._workspaceIndex.onDidDeleteFiles(uris => {
			for (const uri of uris) {
				this._cache.delete(uri);
			}
		}));
	}

	public override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}

	/**
	 * Checks if {@linkcode file} is currently indexed. Does not wait for any current indexing operation to complete.
	 */
	async isIndexed(file: FileRepresentation): Promise<boolean> {
		const entry = await this.getEntry(file);
		return entry?.state === 'resolved';
	}

	async get(file: FileRepresentation): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		return (await this.getEntry(file))?.value;
	}

	getCurrentChunksForUri(uri: URI): ReadonlyMap<string, FileChunkWithEmbedding> | undefined {
		const entry = this._cache.get(uri);
		if (entry?.state === 'resolved' || entry?.state === 'rejected') {
			if (entry.value) {
				const out = new Map<string, FileChunkWithEmbedding>();
				for (const x of entry.value) {
					if (x.chunkHash) {
						out.set(x.chunkHash, x);
					}
				}
				return out;
			}
		}
		return undefined;
	}

	private async getEntry(file: FileRepresentation): Promise<CacheEntry | undefined> {
		const entry = this._cache.get(file.uri);
		if (!entry) {
			return undefined;
		}

		if (entry.contentVersionId === await file.getFastContentVersionId()) {
			return entry;
		}

		return undefined;
	}

	async update(file: FileRepresentation, compute: (token: CancellationToken) => Promise<readonly FileChunkWithEmbedding[] | undefined>): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		const existing = this._cache.get(file.uri);
		const inContentVersionId = await file.getFastContentVersionId();
		if (existing?.contentVersionId === inContentVersionId) {
			// Already up to date
			return existing.value;
		}

		// Overwrite
		if (existing?.state === 'pending') {
			existing.value.cancel();
		}
		const chunks = createCancelablePromise(compute);
		const entry: CacheEntry = {
			contentVersionId: inContentVersionId,
			fileHash: undefined,
			state: 'pending',
			value: chunks
		};
		this._cache.set(file.uri, entry);

		chunks
			.then((result): CacheEntry => {
				return { contentVersionId: inContentVersionId, fileHash: undefined, state: Array.isArray(result) ? 'resolved' : 'rejected', value: result };
			}, (): CacheEntry => {
				return { contentVersionId: inContentVersionId, fileHash: undefined, state: 'rejected', value: undefined };
			})
			.then(newEntry => {
				const current = this._cache.get(file.uri);
				if (entry === current) {
					this._cache.set(file.uri, newEntry);
					return this._writeDelayer.trigger(() => this.save());
				}
			});

		return chunks;
	}

	private async save() {
		if (!this.cachePath || this._isDisposed) {
			return;
		}

		const entries: Record<string, PersistedCacheEntry> = {};
		await Promise.all(Array.from(this._cache.entries(), async ([uri, entry]) => {
			let chunkAndEmbeddings: readonly FileChunkWithEmbedding[] | undefined;
			try {
				// Don't block saving on entries that are still resolving
				chunkAndEmbeddings = entry.state === 'pending' ? await raceTimeout(entry.value, 1000) : entry.value;
			} catch {
				// noop
			}

			if (!chunkAndEmbeddings) {
				return;
			}

			entries[uri.toString()] = {
				contentVersionId: entry.contentVersionId,
				hash: undefined,
				entries: chunkAndEmbeddings.map(x => ({
					text: x.chunk.text,
					range: x.chunk.range.toJSON(),
					embedding: DiskCache.encodeEmbedding(x.embedding.value),
					chunkHash: x.chunkHash,
				})),
			};
		}));

		if (this._isDisposed) {
			return;
		}

		const data: PersistedCache = {
			version: DiskCache.version,
			embeddingModel: this.embeddingType.id,
			entries: entries,
		};
		await this.fileSystem.writeFile(this.cachePath, new TextEncoder().encode(JSON.stringify(data)));

		this.logService.debug(`Wrote workspace chunk + embeddings cache to ${this.cachePath.fsPath}`);
	}
}


class DbCache implements IWorkspaceChunkAndEmbeddingCache {

	public static readonly version = '1.0.0';

	public static async create(
		accessor: ServicesAccessor,
		embeddingType: EmbeddingType,
		cacheRoot: URI,
		workspaceIndex: IWorkspaceFileIndex,
	): Promise<DbCache | undefined> {
		const instantiationService = accessor.get(IInstantiationService);

		const syncOptions: sql.DatabaseSyncOptions = {
			open: true,
			enableForeignKeyConstraints: true
		};

		const dbPath = URI.joinPath(cacheRoot, `workspace-chunks.db`);

		let db: sql.DatabaseSync | undefined;
		if (dbPath.scheme === Schemas.file) {
			try {
				await fs.promises.mkdir(path.dirname(dbPath.fsPath), { recursive: true });
				db = new sql.DatabaseSync(dbPath.fsPath, syncOptions);
			} catch (e) {
				console.error('Failed to open SQLite database on disk', e);
			}
		}
		if (!db) {
			return;
		}

		db.exec(`
			PRAGMA journal_mode = OFF;
			PRAGMA synchronous = 0;
			PRAGMA cache_size = 1000000;
			PRAGMA locking_mode = EXCLUSIVE;
			PRAGMA temp_store = MEMORY;
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS CacheMeta (
				version TEXT NOT NULL,
				embeddingModel TEXT
			);

			CREATE TABLE IF NOT EXISTS Files (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				uri TEXT NOT NULL UNIQUE,
				contentVersionId TEXT
			);

			CREATE TABLE IF NOT EXISTS FileChunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				fileId INTEGER NOT NULL,
				text TEXT NOT NULL,
				range_startLineNumber INTEGER NOT NULL,
				range_startColumn INTEGER NOT NULL,
				range_endLineNumber INTEGER NOT NULL,
				range_endColumn INTEGER NOT NULL,
				embedding BINARY NOT NULL,
				chunkHash TEXT NOT NULL,
				FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_files_uri ON Files(uri);
			CREATE INDEX IF NOT EXISTS idx_filechunks_fileId ON FileChunks(fileId);
		`);

		const versionResult = db.prepare('SELECT version, embeddingModel FROM CacheMeta LIMIT 1').get();
		if (!versionResult || versionResult.version !== this.version || versionResult.embeddingModel !== embeddingType.id) {
			// Clear everything
			db.exec('DELETE FROM CacheMeta; DELETE FROM Files; DELETE FROM FileChunks;');
		}

		// Update cache metadata
		db.exec('DELETE FROM CacheMeta;');
		db.prepare('INSERT INTO CacheMeta (version, embeddingModel) VALUES (?, ?)').run(this.version, embeddingType.id);


		// Load existing disk db if it exists
		const diskCache = await instantiationService.invokeFunction(accessor => DiskCache.readDiskCache(
			accessor,
			embeddingType,
			cacheRoot,
			accessor.get(ILogService)
		));
		if (diskCache) {
			try {
				const insertFileStatement = db.prepare('INSERT OR REPLACE INTO Files (uri, contentVersionId) VALUES (?, ?)');
				const insertChunkStatement = db.prepare(`INSERT INTO FileChunks (fileId, text, range_startLineNumber, range_startColumn, range_endLineNumber, range_endColumn, embedding, chunkHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

				db.exec('BEGIN TRANSACTION');
				for (const [uri, entry] of diskCache) {
					const fileIdResult = insertFileStatement
						.run(uri.toString(), entry.contentVersionId ?? '');

					for (const chunk of entry.entries) {
						insertChunkStatement.run(
							fileIdResult.lastInsertRowid as number,
							chunk.text,
							chunk.range.startLineNumber,
							chunk.range.startColumn,
							chunk.range.endLineNumber,
							chunk.range.endColumn,
							Float32Array.from(typeof chunk.embedding === 'string' ? DiskCache.decodeEmbedding(chunk.embedding) : chunk.embedding),
							chunk.chunkHash ?? ''
						);
					}
				}
			} finally {
				db.exec('COMMIT');
			}

			void instantiationService.invokeFunction(accessor => DiskCache.deleteDiskCache(accessor, cacheRoot));
		}

		// Validate all files in the database against the workspace index and remove any that are no longer present
		await workspaceIndex.initialize();

		const allFilesStmt = db.prepare('SELECT id, uri FROM Files');
		try {
			db.exec('BEGIN TRANSACTION');
			for (const row of allFilesStmt.all()) {
				try {
					const uri = URI.parse(row.uri as string);
					if (workspaceIndex.get(uri)) {
						continue;
					}
				} catch {
					// noop
				}

				db.prepare('DELETE FROM Files WHERE id = ?').run(row.id as number);
			}
		} finally {
			db.exec('COMMIT');
		}

		return new DbCache(embeddingType, db);
	}

	private readonly _inMemory = new ResourceMap<CacheEntry>();

	private constructor(
		private readonly embeddingType: EmbeddingType,
		private readonly db: sql.DatabaseSync
	) { }

	dispose(): void {
		// Noop
	}

	/**
	 * Checks if {@linkcode file} is currently indexed. Does not wait for any current indexing operation to complete.
	 */
	async isIndexed(file: FileRepresentation): Promise<boolean> {
		const entry = await this.getEntry(file);
		return entry?.state === 'resolved';
	}

	async get(file: FileRepresentation): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		return (await this.getEntry(file))?.value;
	}

	getCurrentChunksForUri(uri: URI): ReadonlyMap<string, FileChunkWithEmbedding> | undefined {
		const entry = this._inMemory.get(uri);
		if (entry?.state === 'pending') {
			// Still being computed
			return undefined;
		}

		if (entry?.state === 'rejected') {
			return undefined;
		}

		// Should be written to the database
		const all = this.db.prepare(`SELECT fc.text, fc.range_startLineNumber, fc.range_startColumn, fc.range_endLineNumber, fc.range_endColumn, fc.embedding, fc.chunkHash FROM Files f JOIN FileChunks fc ON f.id = fc.fileId WHERE f.uri = ?`).all(uri.toString());
		if (all.length > 0) {
			const out = new Map<string, FileChunkWithEmbedding>();
			for (const row of all) {
				const embeddingData = row.embedding as Uint8Array;
				const embedding = Array.from(new Float32Array(embeddingData.buffer, embeddingData.byteOffset, embeddingData.byteLength / Float32Array.BYTES_PER_ELEMENT));

				const chunk: FileChunkWithEmbedding = {
					chunk: {
						file: uri,
						text: row.text as string,
						rawText: undefined,
						range: new Range(row.range_startLineNumber as number, row.range_startColumn as number, row.range_endLineNumber as number, row.range_endColumn as number),
					},
					embedding: {
						type: this.embeddingType,
						value: embedding,
					},
					chunkHash: row.chunkHash as string,
				};
				if (chunk.chunkHash) {
					out.set(chunk.chunkHash, chunk);
				}
			}
			return out;
		}

		return undefined;
	}

	private async getEntry(file: FileRepresentation): Promise<CacheEntry | undefined> {
		const entry = this._inMemory.get(file.uri);
		const inContentVersionId = await file.getFastContentVersionId();
		if (entry?.contentVersionId === inContentVersionId) {
			return entry;
		}

		const fileIdResult = this.db.prepare('SELECT id, contentVersionId FROM Files WHERE uri = ?').get(file.uri.toString());
		if (!fileIdResult || fileIdResult.contentVersionId !== inContentVersionId) {
			return undefined;
		}

		const chunks = this.db.prepare(`SELECT text, range_startLineNumber, range_startColumn, range_endLineNumber, range_endColumn, embedding, chunkHash FROM FileChunks WHERE fileId = ?`).all(fileIdResult.id as number);
		return {
			state: 'resolved',
			contentVersionId: fileIdResult.contentVersionId as string | undefined,
			fileHash: undefined,
			value: chunks.map((row): FileChunkWithEmbedding => {
				const embeddingData = row.embedding as Uint8Array;
				return {
					chunk: {
						file: file.uri,
						text: row.text as string,
						rawText: undefined,
						range: new Range(row.range_startLineNumber as number, row.range_startColumn as number, row.range_endLineNumber as number, row.range_endColumn as number),
					},
					embedding: {
						type: this.embeddingType,
						value: Array.from(new Float32Array(embeddingData.buffer, embeddingData.byteOffset, embeddingData.byteLength / Float32Array.BYTES_PER_ELEMENT)),
					},
					chunkHash: row.chunkHash as string | undefined,
				};
			}),
		};
	}

	async update(file: FileRepresentation, compute: (token: CancellationToken) => Promise<readonly FileChunkWithEmbedding[] | undefined>): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		const existingInMemory = this._inMemory.get(file.uri);
		const inContentVersionId = await file.getFastContentVersionId();
		if (existingInMemory?.contentVersionId === inContentVersionId) {
			// Already up to date
			return existingInMemory.value;
		}

		const written = await this.getEntry(file);
		if (written?.contentVersionId === inContentVersionId) {
			return written.value;
		}

		// Overwrite
		if (existingInMemory?.state === 'pending') {
			existingInMemory.value.cancel();
		}

		const chunks = createCancelablePromise(compute);
		const entry: CacheEntry = {
			contentVersionId: inContentVersionId,
			fileHash: undefined,
			state: 'pending',
			value: chunks
		};
		this._inMemory.set(file.uri, entry);

		chunks
			.then((result) => {
				return { contentVersionId: inContentVersionId, fileHash: undefined, state: Array.isArray(result) ? 'resolved' : 'rejected', value: result } as const;
			}, () => {
				return { contentVersionId: inContentVersionId, fileHash: undefined, state: 'rejected', value: undefined } as const;
			})
			.then(newEntry => {
				const current = this._inMemory.get(file.uri);
				if (entry === current) {
					if (newEntry.state === 'rejected') {
						this._inMemory.set(file.uri, newEntry);
						this.db.prepare('DELETE FROM Files WHERE uri = ?').run(file.uri.toString());
					} else {
						this._inMemory.delete(file.uri);
						const fileResult = this.db.prepare('INSERT OR REPLACE INTO Files (uri, contentVersionId) VALUES (?, ?)')
							.run(file.uri.toString(), inContentVersionId);

						try {
							const insertStatement = this.db.prepare(`INSERT INTO FileChunks (fileId, text, range_startLineNumber, range_startColumn, range_endLineNumber, range_endColumn, embedding, chunkHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

							this.db.exec('BEGIN TRANSACTION');
							for (const chunk of newEntry.value ?? []) {
								const float32Array = Float32Array.from(chunk.embedding.value);
								const embeddingData = new Uint8Array(float32Array.buffer, float32Array.byteOffset, float32Array.byteLength);
								insertStatement.run(
									fileResult.lastInsertRowid as number,
									chunk.chunk.text,
									chunk.chunk.range.startLineNumber,
									chunk.chunk.range.startColumn,
									chunk.chunk.range.endLineNumber,
									chunk.chunk.range.endColumn,
									embeddingData,
									chunk.chunkHash ?? '',
								);
							}
						} finally {
							this.db.exec('COMMIT');
						}
					}
				}
			});

		return chunks;
	}
}