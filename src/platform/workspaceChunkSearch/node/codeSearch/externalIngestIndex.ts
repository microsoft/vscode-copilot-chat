/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentContents, getDocSha } from '@github/blackbird-external-ingest-utils';
import sql from 'node:sqlite';
import { Limiter, raceCancellationError } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceSet } from '../../../../util/vs/base/common/map';
import { Schemas } from '../../../../util/vs/base/common/network';
import { isEqualOrParent } from '../../../../util/vs/base/common/resources';
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
import { IWorkspaceService } from '../../../workspace/common/workspaceService';
import { StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings } from '../../common/workspaceChunkSearch';
import { shouldPotentiallyIndexFile } from '../workspaceFileIndex';
import { ExternalIngestFile, IExternalIngestClient } from './externalIngestClient';
import { Result } from '../../../../util/common/result';

const debug = false;

interface DbFileEntry {
	path: string;
	size: number;
	mtime: number;
	docSha: Uint8Array | null;
	shouldIngest: boolean;
}

/**
 * Manages external ingest indexing for files that are NOT covered by GitHub/ADO code search.
 */
export class ExternalIngestIndex extends Disposable {

	private readonly _db: sql.DatabaseSync;

	private readonly _hashLimiter = this._register(new Limiter<Uint8Array>(5));
	private readonly _watcher = this._register(new MutableDisposable<DisposableStore>());

	private _isDisposed = false;

	/**
	 * Set of repo root URIs that are covered by code search.
	 *
	 * Files under these roots should NOT be indexed by external ingest.
	 */
	private readonly _codeSearchRepoRoots = new ResourceSet();

	private readonly _client: IExternalIngestClient;

	constructor(
		client: IExternalIngestClient,
		@IEnvService private readonly _envService: IEnvService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@ISearchService private readonly _searchService: ISearchService,
		@IVSCodeExtensionContext private readonly _vsExtensionContext: IVSCodeExtensionContext,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._client = client;
		this._db = this.createDatabase();
	}

	override dispose(): void {
		this._isDisposed = true;

		super.dispose();

		this._watcher?.dispose();
		this._hashLimiter.dispose();
		this._db.close();
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

	async doIngest(token: CancellationToken): Promise<void> {

		await this.initialize();

		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return;
		}

		// Use the first workspace folder as the "root" for the fileset
		const primaryRoot = workspaceFolders[0];

		await this._client.updateIndex(
			this.getFilesetName(primaryRoot),
			primaryRoot,
			this.getFilesToIndexFromDb(),
			token
		);
	}

	async search(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, token: CancellationToken): Promise<readonly FileChunkAndScore[]> {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return [];
		}

		const resolvedQuery = await query.resolveQuery(token);

		await raceCancellationError(this.doIngest(token), token);

		// TODO: search changed files too
		const primaryRoot = workspaceFolders[0];
		const result = await raceCancellationError(this._client.searchFilesets(
			this.getFilesetName(primaryRoot),
			primaryRoot,
			resolvedQuery,
			sizing.maxResultCountHint,
			token), token);

		return result.chunks;
	}

	private createDatabase(): sql.DatabaseSync {
		let dbPath: string;
		if (debug || !this._vsExtensionContext.storageUri || this._vsExtensionContext.storageUri.scheme !== Schemas.file) {
			dbPath = ':memory:';
		} else {
			dbPath = URI.joinPath(this._vsExtensionContext.storageUri, 'codebase-external.sqlite').fsPath;
		}

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
			CREATE TABLE IF NOT EXISTS Files (
				path TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				mtime INTEGER NOT NULL,
				docSha BLOB,
				shouldIngest INTEGER NOT NULL DEFAULT 0
			);
		`);

		return db;
	}

	private async tryAddOrUpdateFile(uri: URI) {
		const stat = await this.safeStat(uri);
		if (!stat) {
			this.delete(uri);
			return;
		}

		const shouldIngest = await this.shouldIngestFile(uri, stat);

		this._db.prepare(`
			INSERT INTO Files (path, size, mtime, docSha, shouldIngest)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, docSha = excluded.docSha, shouldIngest = excluded.shouldIngest
		`).run(uri.toString(), stat.size, stat.mtime, shouldIngest.isOk() ? shouldIngest.val.docSha : null, shouldIngest.isOk() ? 1 : 0);
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

	private async shouldIngestFile(uri: URI, stat: { readonly size: number; readonly mtime: number }): Promise<Result<{ readonly docSha: Uint8Array }, false>> {
		if (!await this.shouldTrackFile(uri, CancellationToken.None)) {
			return Result.error(false);
		}

		// Quick check based on path and size
		if (!this._client.canIngestPathAndSize(uri.fsPath, stat.size)) {
			return Result.error(false);
		}

		// Complete check based on document contents
		const data = await this._fileSystemService.readFile(uri);
		if (!this._client.canIngestDocument(uri.fsPath, data)) {
			return Result.error(false);
		}

		return Result.ok({ docSha: getDocSha(uri.fsPath, new DocumentContents(data)) });
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
			shouldIngest: (row.shouldIngest as number) > 0
		};
	}

	private async *getFilesToIndexFromDb(): AsyncIterable<ExternalIngestFile> {
		const rows = this._db.prepare('SELECT path, size, mtime, docSha, shouldIngest FROM Files WHERE shouldIngest = 1').all() as unknown as Array<DbFileEntry>;

		for (const row of rows) {
			const uri = URI.parse(row.path);
			// Skip files that are now under code search repos
			if (!await this.shouldTrackFile(uri, CancellationToken.None)) {
				this.delete(uri);
				continue;
			}

			const stat = await this.safeStat(uri);
			if (!stat) {
				this.delete(uri);
				continue;
			}

			const storedSize = row.size;
			const storedMtime = row.mtime;
			const matches = storedSize === stat.size && storedMtime === stat.mtime;
			let docSha: Uint8Array | undefined = matches ? row.docSha ?? undefined : undefined;

			if (!docSha) {
				docSha = await this.computeIngestDocSha(uri);

				if (!docSha) {
					continue;
				}

				// Store the computed docSha in the database
				this._db.prepare('UPDATE Files SET docSha = ? WHERE path = ?').run(docSha, uri.toString());
			}

			yield {
				uri,
				docSha,
				read: () => {
					return this._fileSystemService.readFile(uri);
				}
			};
		}
	}

	private async reconcileDbFiles(): Promise<void> {
		const initialDbFiles = new ResourceSet();
		for (const uri of this.iterateDbFiles()) {
			initialDbFiles.add(uri);
		}

		const seen = new ResourceSet();
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();

		for (const folder of workspaceFolders) {
			const paths = await this._searchService.findFilesWithDefaultExcludes(
				new RelativePattern(folder, '**/*'),
				Number.MAX_SAFE_INTEGER,
				CancellationToken.None
			);

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
				if (!existing || existing.size !== stat.size || existing.mtime !== stat.mtime) {
					await this.tryAddOrUpdateFile(uri);
				}
			}
		}

		// Remove files that no longer exist
		for (const uri of initialDbFiles) {
			if (!seen.has(uri)) {
				this.delete(uri);
			}
		}
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

	private async computeIngestDocSha(uri: URI): Promise<Uint8Array | undefined> {
		return this._hashLimiter.queue(async () => {
			try {
				const data = await this._fileSystemService.readFile(uri);
				return getDocSha(uri.fsPath, new DocumentContents(data));
			} catch {
				return undefined;
			}
		});
	}

	private getFilesetName(workspaceRoot: URI): string {
		const folderName = workspaceRoot.path;
		return `vscode.${this._envService.getName()}.${folderName}`;
	}

	private *iterateDbFiles(): Iterable<URI> {
		const rows = this._db.prepare('SELECT path FROM Files').all() as Array<{ path: string }>;
		for (const row of rows) {
			yield URI.parse(row.path);
		}
	}
}
