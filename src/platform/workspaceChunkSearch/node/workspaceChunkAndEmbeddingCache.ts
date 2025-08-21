/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'fs';
import { IDisposable } from 'monaco-editor';
import sql from 'node:sqlite';
import path from 'path';
import { CancelablePromise, createCancelablePromise } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { Schemas } from '../../../util/vs/base/common/network';
import { URI } from '../../../util/vs/base/common/uri';
import { IRange, Range } from '../../../util/vs/editor/common/core/range';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { FileChunkWithEmbedding } from '../../chunking/common/chunk';
import { Embedding, EmbeddingType, EmbeddingVector, getWellKnownEmbeddingTypeInfo } from '../../embeddings/common/embeddingsComputer';
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
	return instantiationService.invokeFunction(accessor => DbCache.create(accessor, embeddingType, cacheRoot ?? ':memory:', workspaceIndex));
}

class OldDiskCache {
	private static readonly version = '1.0.0';
	private static cacheFileName = 'workspace-chunks.json';

	public static decodeEmbedding(base64Str: string): EmbeddingVector {
		const decoded = Buffer.from(base64Str, 'base64');
		const float32Array = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / Float32Array.BYTES_PER_ELEMENT);
		return Array.from(float32Array);
	}

	public static async readDiskCache(accessor: ServicesAccessor, embeddingType: EmbeddingType, cacheRoot: URI, logService: ILogService): Promise<Iterable<[string, PersistedCacheEntry]> | undefined> {
		const fileSystem = accessor.get(IFileSystemService);

		const cachePath = URI.joinPath(cacheRoot, OldDiskCache.cacheFileName);
		try {
			let file: Uint8Array | undefined;
			try {
				file = await fileSystem.readFile(cachePath, true);
			} catch (e) {
				// Expected, most likely file doesn't exist
				return undefined;
			}

			const data: PersistedCache = JSON.parse(new TextDecoder().decode(file));
			if (data.version !== OldDiskCache.version) {
				logService.debug(`WorkspaceChunkAndEmbeddingCache: invalidating cache due to version mismatch. Expected ${OldDiskCache.version} but found ${data.version}`);
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
		const cachePath = URI.joinPath(cacheRoot, OldDiskCache.cacheFileName);
		try {
			await fileSystem.delete(cachePath);
		} catch {
			// noop
		}
	}

	private constructor() { }
}


class DbCache implements IWorkspaceChunkAndEmbeddingCache {

	public static readonly version = '1.0.0';

	public static async create(
		accessor: ServicesAccessor,
		embeddingType: EmbeddingType,
		cacheRoot: URI | ':memory:',
		workspaceIndex: IWorkspaceFileIndex,
	): Promise<DbCache> {
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);

		const syncOptions: sql.DatabaseSyncOptions = {
			open: true,
			enableForeignKeyConstraints: true
		};


		let db: sql.DatabaseSync | undefined;
		if (cacheRoot !== ':memory:' && cacheRoot.scheme === Schemas.file) {
			const dbPath = URI.joinPath(cacheRoot, `workspace-chunks.db`);
			try {
				await fs.promises.mkdir(path.dirname(dbPath.fsPath), { recursive: true });
				db = new sql.DatabaseSync(dbPath.fsPath, syncOptions);
				logService.trace(`DbWorkspaceChunkAndEmbeddingCache: Opened SQLite database on disk at ${dbPath.fsPath}`);
			} catch (e) {
				console.error('Failed to open SQLite database on disk', e);
			}
		}

		if (!db) {
			db = new sql.DatabaseSync(':memory:', syncOptions);
			logService.trace(`DbWorkspaceChunkAndEmbeddingCache: Using in memory database`);
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
		const diskCache = cacheRoot !== ':memory:' ?
			await instantiationService.invokeFunction(accessor => OldDiskCache.readDiskCache(
				accessor,
				embeddingType,
				cacheRoot,
				accessor.get(ILogService)
			))
			: undefined;
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
							packEmbedding({
								type: embeddingType,
								value: typeof chunk.embedding === 'string' ? OldDiskCache.decodeEmbedding(chunk.embedding) : chunk.embedding,
							}),
							chunk.chunkHash ?? ''
						);
					}
				}
			} finally {
				db.exec('COMMIT');
			}

			if (cacheRoot !== ':memory:') {
				void instantiationService.invokeFunction(accessor => OldDiskCache.deleteDiskCache(accessor, cacheRoot));
			}
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
				const embedding = unpackEmbedding(this.embeddingType, row.embedding as Uint8Array);

				const chunk: FileChunkWithEmbedding = {
					chunk: {
						file: uri,
						text: row.text as string,
						rawText: undefined,
						range: new Range(row.range_startLineNumber as number, row.range_startColumn as number, row.range_endLineNumber as number, row.range_endColumn as number),
					},
					embedding,
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
				return {
					chunk: {
						file: file.uri,
						text: row.text as string,
						rawText: undefined,
						range: new Range(row.range_startLineNumber as number, row.range_startColumn as number, row.range_endLineNumber as number, row.range_endColumn as number),
					},
					embedding: unpackEmbedding(this.embeddingType, row.embedding as Uint8Array),
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
								insertStatement.run(
									fileResult.lastInsertRowid as number,
									chunk.chunk.text,
									chunk.chunk.range.startLineNumber,
									chunk.chunk.range.startColumn,
									chunk.chunk.range.endLineNumber,
									chunk.chunk.range.endColumn,
									packEmbedding(chunk.embedding),
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

/**
 * Packs the embedding into a binary value for efficient storage.
 */
export function packEmbedding(embedding: Embedding): Uint8Array {
	const embeddingMetadata = getWellKnownEmbeddingTypeInfo(embedding.type);
	if (embeddingMetadata?.quantization.document === 'binary') {
		// Generate packed binary
		if (embedding.value.length % 8 !== 0) {
			throw new Error(`Embedding value length must be a multiple of 8 for ${embedding.type.id}, got ${embedding.value.length}`);
		}

		const data = new Uint8Array(embedding.value.length / 8);
		for (let i = 0; i < embedding.value.length; i += 8) {
			let value = 0;
			for (let j = 0; j < 8; j++) {
				value |= (embedding.value[i + j] >= 0 ? 1 : 0) << j;
			}
			data[i / 8] = value;
		}
		return data;
	}

	// All other formats default to float32 for now
	const data = Float32Array.from(embedding.value);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Unpacks an embedding from a binary value packed with {@link packEmbedding}.
 */
export function unpackEmbedding(type: EmbeddingType, data: Uint8Array): Embedding {
	const embeddingMetadata = getWellKnownEmbeddingTypeInfo(type);
	if (embeddingMetadata?.quantization.document === 'binary') {
		// Old metis versions may have stored the values as a float32
		if (!(type.equals(EmbeddingType.metis_1024_I16_Binary) && data.length >= 1024)) {
			const values = new Array(data.length * 8);
			for (let i = 0; i < data.length; i++) {
				const byte = data[i];
				for (let j = 0; j < 8; j++) {
					values[i * 8 + j] = (byte & (1 << j)) > 0 ? 0.03125 : -0.03125;
				}
			}
			return { type, value: values };
		}
	}

	const float32Array = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
	return { type, value: Array.from(float32Array) };
}