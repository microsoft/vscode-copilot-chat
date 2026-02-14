/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as ingestUtils from '@github/blackbird-external-ingest-utils';
import * as l10n from '@vscode/l10n';
import * as fs from 'node:fs';
import sql from 'node:sqlite';
import { Result } from '../../../../util/common/result';
import { CallTracker } from '../../../../util/common/telemetryCorrelationId';
import { Limiter, raceCancellationError } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { hashAsync } from '../../../../util/vs/base/common/hash';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceSet } from '../../../../util/vs/base/common/map';
import { Schemas } from '../../../../util/vs/base/common/network';
import { isEqualOrParent, relativePath } from '../../../../util/vs/base/common/resources';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { FileChunkAndScore } from '../../../chunking/common/chunk';
import { IEnvService } from '../../../env/common/envService';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { IFileSystemService } from '../../../filesystem/common/fileSystemService';
import { RelativePattern } from '../../../filesystem/common/fileTypes';
import { IIgnoreService } from '../../../ignore/common/ignoreService';
import { ILogService } from '../../../log/common/logService';
import { ISearchService } from '../../../search/common/searchService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { IWorkspaceService } from '../../../workspace/common/workspaceService';
import { StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings } from '../../common/workspaceChunkSearch';
import { shouldPotentiallyIndexFile } from '../workspaceFileIndex';
import { CodeSearchRepoStatus, TriggerIndexingError, TriggerRemoteIndexingError } from './codeSearchRepo';
import { ExternalIngestFile, IExternalIngestClient } from './externalIngestClient';

const debug = false;

const maxFileSetNameLength = 256;

const enum ShouldIngestState {
	/** File is tracked but we haven't yet determined if it should be ingested */
	Undetermined = 0,
	/** File should not be ingested */
	No = 1,
	/** File should be ingested */
	Yes = 2,
}

interface DbFileEntry {
	path: string;
	size: number;
	mtime: number;
	docSha: Uint8Array | null;
	shouldIngest: ShouldIngestState;
}

export interface ExternalIngestStatus {
	readonly status: CodeSearchRepoStatus;
	readonly progressMessage: string | undefined;
}

/**
 * Manages external ingest indexing for files that are NOT covered by GitHub/ADO code search.
 */
export class ExternalIngestIndex extends Disposable {

	private readonly _db: sql.DatabaseSync;

	private readonly _readLimiter = this._register(new Limiter<Uint8Array>(20));
	private readonly _watcher = this._register(new MutableDisposable<DisposableStore>());

	private static readonly _checkpointStorageKey = 'externalIngest.checkpoint';

	private _isDisposed = false;

	/**
	 * Set of repo root URIs that are covered by code search.
	 *
	 * Files under these roots should NOT be indexed by external ingest.
	 */
	private readonly _codeSearchRepoRoots = new ResourceSet();

	private readonly _client: IExternalIngestClient;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	public readonly onDidChangeState = this._onDidChangeState.event;

	private _currentIngestOperation?: {
		promise: Promise<Result<true, TriggerIndexingError>>;

		progressMessage: string | undefined;

		completed: boolean;
	};

	/**
	 * Returns the current index state.
	 */
	public getState(): ExternalIngestStatus {
		if (this._currentIngestOperation) {
			if (this._currentIngestOperation.completed) {
				return {
					status: CodeSearchRepoStatus.Ready,
					progressMessage: undefined,
				};
			} else {
				return {
					status: CodeSearchRepoStatus.BuildingIndex,
					progressMessage: this._currentIngestOperation.progressMessage,
				};
			}
		}

		if (this.getCurrentIndexCheckpoint()) {
			return {
				status: CodeSearchRepoStatus.Ready,
				progressMessage: undefined,
			};
		}

		return {
			status: CodeSearchRepoStatus.NotYetIndexed,
			progressMessage: undefined,
		};
	}

	constructor(
		client: IExternalIngestClient,
		@IEnvService private readonly _envService: IEnvService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@ISearchService private readonly _searchService: ISearchService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IVSCodeExtensionContext private readonly _vsExtensionContext: IVSCodeExtensionContext,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._client = client;

		let dbPath: string;
		if (debug || !this._vsExtensionContext.storageUri || this._vsExtensionContext.storageUri.scheme !== Schemas.file) {
			dbPath = ':memory:';
		} else {
			dbPath = URI.joinPath(this._vsExtensionContext.storageUri, 'codebase-external.sqlite').fsPath;
		}

		try {
			this._db = this.openOrCreateDatabase(dbPath);
		} catch (error) {
			this._logService.error('Failed to create database. Falling back to in-memory db', error);
			this._db = this.createFreshDatabase(':memory:');
		}
	}

	override dispose(): void {
		this._isDisposed = true;

		super.dispose();

		this._watcher?.dispose();
		this._readLimiter.dispose();
		this._db.close();
	}

	private getCurrentIndexCheckpoint(): string | undefined {
		return this._vsExtensionContext.workspaceState.get<string>(ExternalIngestIndex._checkpointStorageKey);
	}

	private setCurrentIndexCheckpoint(checkpoint: string): void {
		this._vsExtensionContext.workspaceState.update(ExternalIngestIndex._checkpointStorageKey, checkpoint);
	}

	private clearCurrentIndexCheckpoint(): void {
		this._vsExtensionContext.workspaceState.update(ExternalIngestIndex._checkpointStorageKey, undefined);
	}

	/**
	 * Deletes the external ingest index for the current workspace.
	 *
	 * This deletes the remote file set and the checkpoint. We keep around the local database because it
	 * has a cache of file shas.
	 */
	public async deleteIndex(callTracker: CallTracker, token: CancellationToken): Promise<void> {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return;
		}

		const primaryRoot = workspaceFolders[0];
		const filesetName = await this.getFilesetName(primaryRoot);
		this._logService.info(`ExternalIngestIndex: Deleting index for fileset ${filesetName}`);

		try {
			await this._client.deleteFileset(filesetName, callTracker, token);
			this.clearCurrentIndexCheckpoint();
			this._onDidChangeState.fire();

			this._logService.info(`ExternalIngestIndex: Deleted index for fileset ${filesetName}`);

			/* __GDPR__
				"externalIngestIndex.deleteIndex" : {
					"owner": "mjbvz",
					"comment": "Logged when external ingest index is deleted successfully"
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('externalIngestIndex.deleteIndex');
		} catch (e) {
			/* __GDPR__
				"externalIngestIndex.deleteIndex.error" : {
					"owner": "mjbvz",
					"comment": "Logged when deleting external ingest index fails",
					"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The error message" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryErrorEvent('externalIngestIndex.deleteIndex.error', { error: (e as Error).message });
			throw e;
		}
	}

	/**
	 * Updates the set of roots that are covered by code search.
	 * Files under these roots will be excluded from external ingest indexing.
	 */
	public updateCodeSearchRoots(roots: readonly URI[]): void {
		this._codeSearchRepoRoots.clear();
		for (const root of roots) {
			this._codeSearchRepoRoots.add(root);
		}

		this._logService.trace(`ExternalIngestIndex: Updated code search roots: ${roots.map(r => r.toString()).join(', ')}`);
	}

	private _initializePromise: Promise<void> | undefined;

	async initialize(): Promise<void> {
		this._initializePromise ??= (async () => {
			await this._ignoreService.init();
			if (this._isDisposed) {
				return;
			}

			await this.reconcileDbFiles();
			if (this._isDisposed) {
				return;
			}

			this.registerWatcher();
		})();

		return this._initializePromise;
	}

	async doIngest(callTracker: CallTracker, onProgress: (message: string) => void, token: CancellationToken): Promise<Result<true, TriggerIndexingError>> {
		await raceCancellationError(this.initialize(), token);

		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return Result.error(TriggerRemoteIndexingError.noWorkspace);
		}

		// Use the first workspace folder as the "root" for the fileset
		const primaryRoot = workspaceFolders[0];

		const currentCheckpoint = this.getCurrentIndexCheckpoint();

		// Track building state
		const operation: typeof this._currentIngestOperation = {
			promise: undefined!,
			progressMessage: undefined,
			completed: false,
		};

		const wrappedOnProgress = (message: string) => {
			if (this._currentIngestOperation === operation) {
				operation.progressMessage = message;
				this._onDidChangeState.fire();
			}

			onProgress(message);
		};

		const sw = new StopWatch();

		const updatePromise = (async (): Promise<Result<true, TriggerIndexingError>> => {
			try {
				const result = await this._client.updateIndex(
					await this.getFilesetName(primaryRoot),
					currentCheckpoint,
					this.getFilesToIndexFromDb(token),
					callTracker,
					token,
					wrappedOnProgress
				);
				if (result.isOk()) {
					this.setCurrentIndexCheckpoint(result.val.checkpoint);

					/* __GDPR__
						"externalIngestIndex.updateIndex.success" : {
							"owner": "mjbvz",
							"comment": "Logged when external ingest index update completes successfully",
							"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time taken to complete the update in milliseconds" }
						}
					*/
					this._telemetryService.sendMSFTTelemetryEvent('externalIngestIndex.updateIndex.success', undefined, { durationMs: sw.elapsed() });

					return Result.ok(true);
				} else {
					/* __GDPR__
						"externalIngestIndex.updateIndex.error" : {
							"owner": "mjbvz",
							"comment": "Logged when external ingest index update fails",
							"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The error message" },
							"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time taken before failure in milliseconds" }
						}
					*/
					this._telemetryService.sendMSFTTelemetryErrorEvent('externalIngestIndex.updateIndex.error', { error: result.err.message }, { durationMs: sw.elapsed() });

					return Result.error({
						id: 'external-ingest-error',
						userMessage: l10n.t("Failed to update external ingest index: {0}", result.err.message)
					});
				}
			} catch (e) {
				/* __GDPR__
					"externalIngestIndex.updateIndex.exception" : {
						"owner": "mjbvz",
						"comment": "Logged when external ingest index update throws an exception",
						"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The exception message" },
						"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time taken before exception in milliseconds" }
					}
				*/
				this._telemetryService.sendMSFTTelemetryErrorEvent('externalIngestIndex.updateIndex.exception', { error: (e as Error).message }, { durationMs: sw.elapsed() });

				return Result.error({
					id: 'external-ingest-error',
					userMessage: l10n.t("Exception updating external ingest index: {0}", (e as Error).message)
				});
			} finally {
				if (this._currentIngestOperation === operation) {
					operation.completed = true;
				}
				this._onDidChangeState.fire();
			}
		})();

		operation.promise = updatePromise;
		this._currentIngestOperation = operation;
		this._onDidChangeState.fire();

		return updatePromise;
	}

	async search(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, callTracker: CallTracker, token: CancellationToken): Promise<readonly FileChunkAndScore[]> {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return [];
		}

		const sw = new StopWatch();

		try {
			const resolvedQuery = await query.resolveQuery(token);

			await raceCancellationError(this.doIngest(callTracker, () => { }, token), token);

			// TODO: search changed files too
			const primaryRoot = workspaceFolders[0];
			const result = await raceCancellationError(this._client.searchFilesets(
				await this.getFilesetName(primaryRoot),
				primaryRoot,
				resolvedQuery,
				sizing.maxResultCountHint,
				callTracker,
				token), token);

			/* __GDPR__
				"externalIngestIndex.search.success" : {
					"owner": "mjbvz",
					"comment": "Logged when external ingest search completes successfully",
					"resultCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of chunks returned from the search" },
					"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time taken to complete the search in milliseconds" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('externalIngestIndex.search.success', undefined, {
				resultCount: result.chunks.length,
				durationMs: sw.elapsed()
			});

			return result.chunks;
		} catch (e) {
			/* __GDPR__
				"externalIngestIndex.search.error" : {
					"owner": "mjbvz",
					"comment": "Logged when external ingest search fails",
					"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "The error message" },
					"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time taken before failure in milliseconds" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryErrorEvent('externalIngestIndex.search.error', { error: (e as Error).message }, { durationMs: sw.elapsed() });
			throw e;
		}
	}

	private openOrCreateDatabase(dbPath: string | ':memory:'): sql.DatabaseSync {
		this._logService.trace(`ExternalIngestIndex: Opening database at path: ${dbPath}`);

		// For in-memory databases, always create fresh
		if (dbPath === ':memory:') {
			return this.createFreshDatabase(dbPath);
		}

		// Try to open existing database and check cache version
		if (fs.existsSync(dbPath)) {
			try {
				const db = new sql.DatabaseSync(dbPath, {
					open: true,
					enableForeignKeyConstraints: true,
				});

				const storedVersion = this.getStoredCacheVersion(db);
				if (storedVersion === ingestUtils.cacheVersion()) {
					this._logService.trace(`ExternalIngestIndex: Cache version matches (${ingestUtils.cacheVersion()})`);
					return db;
				}

				// Version mismatch - close and delete
				this._logService.info(`ExternalIngestIndex: Cache version mismatch (stored: ${storedVersion}, current: ${ingestUtils.cacheVersion()}). Recreating database.`);
				db.close();
			} catch (error) {
				this._logService.warn(`ExternalIngestIndex: Failed to open existing database, will recreate: ${error}`);
			}

			// Delete the old database file
			try {
				fs.unlinkSync(dbPath);
			} catch (error) {
				this._logService.warn(`ExternalIngestIndex: Failed to delete old database file: ${error}`);
			}
		}

		return this.createFreshDatabase(dbPath);
	}

	private getStoredCacheVersion(db: sql.DatabaseSync): number | undefined {
		try {
			const row = db.prepare('SELECT value FROM Metadata WHERE key = ?').get('cacheVersion');
			if (row && typeof row.value === 'number') {
				return row.value;
			}
		} catch {
			// Table may not exist in older databases
		}
		return undefined;
	}

	private createFreshDatabase(dbPath: string | ':memory:'): sql.DatabaseSync {
		this._logService.trace(`ExternalIngestIndex: Creating fresh database at path: ${dbPath}`);

		const db = new sql.DatabaseSync(dbPath, {
			open: true,
			enableForeignKeyConstraints: true,
		});

		db.exec(`PRAGMA foreign_keys = ON;`);
		db.exec(`
			PRAGMA journal_mode = OFF;
			PRAGMA synchronous = 0;
			PRAGMA cache_size = 1000000;
			PRAGMA locking_mode = EXCLUSIVE;
			PRAGMA temp_store = MEMORY;
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS Metadata (
				key TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			);
		`);

		db.exec(`
			CREATE TABLE IF NOT EXISTS Files (
				path TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				mtime INTEGER NOT NULL,
				docSha BLOB,
				shouldIngest INTEGER NOT NULL DEFAULT 0
			);
		`);

		// Store the current cache version
		db.prepare('INSERT OR REPLACE INTO Metadata (key, value) VALUES (?, ?)').run('cacheVersion', ingestUtils.cacheVersion());

		return db;
	}

	private async tryAddOrUpdateFile(uri: URI) {
		const stat = await this.safeStat(uri);
		if (!stat) {
			this.delete(uri);
			return;
		}

		// Check if file already exists and hasn't changed
		const existing = this.get(uri);
		if (existing && existing.size === stat.size && existing.mtime === stat.mtime) {
			// File unchanged, keep existing state
			return;
		}

		// New or changed file - set to Undetermined so it will be evaluated later
		this._db.prepare(`
			INSERT INTO Files (path, size, mtime, docSha, shouldIngest)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, docSha = NULL, shouldIngest = excluded.shouldIngest
		`).run(uri.toString(), stat.size, stat.mtime, null, ShouldIngestState.Undetermined);
	}

	/**
	 * Determines whether the given file should be tracked by the external ingest index.
	 *
	 * This does NOT consider whether the file should be ingested, only whether it should be tracked.
	 */
	public async shouldTrackFile(uri: URI, token: CancellationToken): Promise<boolean> {
		// TODO: Support non-file schemes?
		if (uri.scheme !== Schemas.file) {
			return false;
		}

		// Only track files within the current workspace
		if (!this._instantiationService.invokeFunction(accessor => shouldPotentiallyIndexFile(accessor, uri))) {
			return false;
		}

		// Don't index files that are under a code search repo root
		for (const root of this._codeSearchRepoRoots) {
			if (isEqualOrParent(uri, root)) {
				return false;
			}
		}

		return !await this._ignoreService.isCopilotIgnored(uri, token);
	}

	private async shouldIngestFile(uri: URI, stat: { readonly size: number; readonly mtime: number }, token: CancellationToken): Promise<Result<{ readonly docSha: Uint8Array }, false>> {
		if (!await this.shouldTrackFile(uri, token)) {
			return Result.error(false);
		}

		// Quick check based on path and size
		if (!this._client.canIngestPathAndSize(uri.fsPath, stat.size)) {
			return Result.error(false);
		}

		// Complete check based on document contents
		const data = await this._readLimiter.queue(() => this._fileSystemService.readFile(uri));
		if (!this._client.canIngestDocument(uri.fsPath, data)) {
			return Result.error(false);
		}

		return Result.ok({
			docSha: this.computeIngestDocShaFromContents(uri, data)
		});
	}

	private delete(uri: URI) {
		this._db.prepare('DELETE FROM Files WHERE path = ?').run(uri.toString());
	}

	private get(uri: URI): DbFileEntry | undefined {
		const row = this._db.prepare('SELECT size, mtime, docSha, shouldIngest FROM Files WHERE path = ?').get(uri.toString());
		if (!row) {
			return undefined;
		}

		return {
			path: uri.toString(),
			size: row.size as number,
			mtime: row.mtime as number,
			docSha: row.docSha as Uint8Array | null,
			shouldIngest: row.shouldIngest as ShouldIngestState
		};
	}

	private computeRelativePath(uri: URI): string {
		const folder = this._workspaceService.getWorkspaceFolder(uri);
		if (folder) {
			const rel = relativePath(folder, uri);
			if (rel) {
				return rel;
			}
		}

		// Fall back to full path if not under any workspace folder
		return uri.fsPath;
	}

	private createExternalIngestFile(uri: URI, docSha: Uint8Array): ExternalIngestFile {
		return {
			uri,
			relativePath: this.computeRelativePath(uri),
			docSha,
			read: () => this._readLimiter.queue(() => this._fileSystemService.readFile(uri)),
		};
	}

	private async *getFilesToIndexFromDb(token: CancellationToken): AsyncIterable<ExternalIngestFile> {
		// Get files that are either already marked "Yes" or "need to be evaluated" (Undetermined)
		const rows = this._db.prepare('SELECT path, size, mtime, docSha, shouldIngest FROM Files WHERE shouldIngest IN (?, ?)').all(ShouldIngestState.Yes, ShouldIngestState.Undetermined) as unknown as Array<DbFileEntry>;

		const limiter = new Limiter<ExternalIngestFile | undefined>(20);

		const processRow = async (row: DbFileEntry): Promise<ExternalIngestFile | undefined> => {
			const uri = URI.parse(row.path);

			// Skip files that are now under code search repos
			if (!await this.shouldTrackFile(uri, token)) {
				this.delete(uri);
				return undefined;
			}

			const stat = await raceCancellationError(this.safeStat(uri), token);
			if (!stat) {
				this.delete(uri);
				return undefined;
			}

			const storedSize = row.size;
			const storedMtime = row.mtime;
			const fileUnchanged = storedSize === stat.size && storedMtime === stat.mtime;

			// If file state is undetermined, we need to evaluate it
			if (row.shouldIngest === ShouldIngestState.Undetermined) {
				const result = await this.shouldIngestFile(uri, stat, token);
				if (result.isOk()) {
					this._db.prepare('UPDATE Files SET shouldIngest = ?, docSha = ?, size = ?, mtime = ? WHERE path = ?')
						.run(ShouldIngestState.Yes, result.val.docSha, stat.size, stat.mtime, uri.toString());

					return this.createExternalIngestFile(uri, result.val.docSha);
				} else {
					this._db.prepare('UPDATE Files SET shouldIngest = ?, size = ?, mtime = ? WHERE path = ?')
						.run(ShouldIngestState.No, stat.size, stat.mtime, uri.toString());
				}
				return undefined;
			}

			// File is already marked Yes - use cached docSha if file unchanged
			let docSha: Uint8Array | undefined = fileUnchanged ? row.docSha ?? undefined : undefined;

			if (!docSha) {
				docSha = await raceCancellationError(this.computeIngestDocSha(uri), token);
				if (!docSha) {
					return undefined;
				}

				// Store the computed docSha in the database
				this._db.prepare('UPDATE Files SET docSha = ? WHERE path = ?').run(docSha, uri.toString());
			}

			return this.createExternalIngestFile(uri, docSha);
		};

		// Queue all work upfront to run in parallel, then yield results in order as they complete
		const pendingResults = rows.map(row => limiter.queue(() => processRow(row)));

		for (const pending of pendingResults) {
			const result = await raceCancellationError(pending, token);
			if (result) {
				yield result;
			}
		}
	}

	private async reconcileDbFiles(): Promise<void> {
		await this._workspaceService.ensureWorkspaceIsFullyLoaded();
		await this._ignoreService.init();

		const initialDbFiles = new ResourceSet();
		for (const uri of this.iterateDbFiles()) {
			initialDbFiles.add(uri);
		}

		this._logService.trace(`ExternalIngestIndex::reconcileDbFiles() Found ${initialDbFiles.size} initial file entries in database.`);

		let addedFileCount = 0;
		let updatedFileCount = 0;
		let removedFileCount = 0;

		const seen = new ResourceSet();
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();

		for (const folder of workspaceFolders) {
			const paths = await this._searchService.findFilesWithDefaultExcludes(
				new RelativePattern(folder, '**/*'),
				Number.MAX_SAFE_INTEGER,
				CancellationToken.None
			);

			this._logService.trace(`ExternalIngestIndex::reconcileDbFiles() Found ${paths.length} candidate files in workspace folder ${folder.toString()}.`);

			for (const uri of paths) {
				// Skip files under code search repos
				if (!await this.shouldTrackFile(uri, CancellationToken.None)) {
					continue;
				}

				const stat = await this.safeStat(uri);
				if (!stat) {
					continue;
				}

				seen.add(uri);

				const existing = this.get(uri);
				if (!existing) {
					await this.tryAddOrUpdateFile(uri);
					addedFileCount++;
				} else if (existing.size !== stat.size || existing.mtime !== stat.mtime) {
					await this.tryAddOrUpdateFile(uri);
					updatedFileCount++;
				}
			}
		}

		// Remove files that no longer exist
		for (const uri of initialDbFiles) {
			if (!seen.has(uri)) {
				this.delete(uri);
				removedFileCount++;
			}
		}
		this._logService.trace(`ExternalIngestIndex::reconcileDbFiles() Reconciled database. Added: ${addedFileCount}, updated: ${updatedFileCount}, removed: ${removedFileCount}`);
	}

	private registerWatcher(): void {
		if (this._watcher.value) {
			return;
		}

		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		const disposables = new DisposableStore();

		for (const folder of workspaceFolders) {
			const watcher = disposables.add(this._fileSystemService.createFileSystemWatcher(new RelativePattern(folder, '**/*')));
			disposables.add(watcher.onDidCreate(uri => this.onFileAdded(uri)));
			disposables.add(watcher.onDidChange(uri => this.onFileChanged(uri)));
			disposables.add(watcher.onDidDelete(uri => this.onFileDeleted(uri)));
		}
		this._watcher.value = disposables;
	}

	private async onFileAdded(uri: URI): Promise<void> {
		if (!await this.shouldTrackFile(uri, CancellationToken.None)) {
			return;
		}

		await this.tryAddOrUpdateFile(uri);
	}

	private async onFileChanged(uri: URI): Promise<void> {
		if (!await this.shouldTrackFile(uri, CancellationToken.None)) {
			return;
		}

		await this.tryAddOrUpdateFile(uri);
	}

	private onFileDeleted(uri: URI): void {
		this.delete(uri);
		this.deleteFolder(uri);
	}

	private deleteFolder(folder: URI): void {
		const folderKey = folder.toString().replace(/\/?$/, '/');
		this._db.prepare('DELETE FROM Files WHERE path LIKE ?').run(`${folderKey}%`);
	}

	private async safeStat(uri: URI): Promise<{ size: number; mtime: number } | undefined> {
		try {
			const stat = await this._fileSystemService.stat(uri);
			// Check it's a file, not a directory
			if (stat.type !== 1) { // FileType.File = 1
				return undefined;
			}
			return { size: stat.size, mtime: stat.mtime };
		} catch {
			return undefined;
		}
	}

	private computeIngestDocShaFromContents(uri: URI, data: Uint8Array): Uint8Array {
		return ingestUtils.getDocSha(this.computeRelativePath(uri), new ingestUtils.DocumentContents(data));
	}

	private async computeIngestDocSha(uri: URI): Promise<Uint8Array | undefined> {
		try {
			const data = await this._readLimiter.queue(() => this._fileSystemService.readFile(uri));
			return this.computeIngestDocShaFromContents(uri, data);
		} catch {
			return undefined;
		}
	}

	private async getFilesetName(workspaceRoot: URI): Promise<string> {
		const folderName = workspaceRoot.toString(false);

		const prefix = `vscode.${this._envService.getName()}.`;
		const fullName = `${prefix}${folderName}`;

		if (fullName.length >= maxFileSetNameLength) {
			const hash = await hashAsync(folderName);
			return `${prefix}${hash}`;
		}

		return fullName;
	}

	private *iterateDbFiles(): Iterable<URI> {
		const rows = this._db.prepare('SELECT path FROM Files').all() as Array<{ path: string }>;
		for (const row of rows) {
			yield URI.parse(row.path);
		}
	}
}
