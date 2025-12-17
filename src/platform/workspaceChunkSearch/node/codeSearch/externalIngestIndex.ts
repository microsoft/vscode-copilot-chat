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
import { IAuthenticationService } from '../../../authentication/common/authentication';
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
import { shouldAlwaysIgnoreFile } from '../workspaceFileIndex';
import { ExternalIngestClient } from './externalIngestClient';

const debug = false;

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

	private readonly _client: ExternalIngestClient;

	constructor(
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEnvService private readonly _envService: IEnvService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@ISearchService private readonly _searchService: ISearchService,
		@IVSCodeExtensionContext private readonly _vsExtensionContext: IVSCodeExtensionContext,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._client = instantiationService.createInstance(ExternalIngestClient);
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

	/**
	 * Checks if a file should be indexed by external ingest.
	 * Returns false if the file is under a code search repo root.
	 */
	public shouldIndexFile(uri: URI): boolean {
		// Don't index files that are under a code search repo root
		for (const root of this._codeSearchRepoRoots) {
			if (isEqualOrParent(uri, root)) {
				return false;
			}
		}
		return true;
	}

	private _initializePromise: Promise<void> | undefined;

	async initialize(): Promise<void> {
		this._initializePromise ??= (async () => {
			await this._ignoreService.init();
			if (this._isDisposed) {
				return;
			}

			await this.reconcileFiles();
			if (this._isDisposed) {
				return;
			}

			this.registerWatcher();
		})();

		return this._initializePromise;
	}

	async doInitialIngest(token: CancellationToken): Promise<void> {
		await this.initialize();

		const authToken = await this.getGithubAuthToken();
		if (!authToken) {
			this._logService.warn('ExternalIngestIndex: No auth token available for initial ingest');
			return;
		}

		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return;
		}

		// Use the first workspace folder as the "root" for the fileset
		const primaryRoot = workspaceFolders[0];

		await this._client.doInitialIndex(
			authToken,
			this.getFilesetName(primaryRoot),
			primaryRoot,
			this.getFilesToIndex(),
			token
		);
	}

	async search(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, token: CancellationToken): Promise<readonly FileChunkAndScore[]> {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return [];
		}

		const authToken = await this.getGithubAuthToken();
		if (!authToken) {
			this._logService.warn('ExternalIngestIndex: No auth token available for search');
			return [];
		}

		const resolvedQuery = await query.resolveQuery(token);

		// TODO: Don't fire this so often
		await raceCancellationError(this.doInitialIngest(token), token);

		const primaryRoot = workspaceFolders[0];
		const result = await raceCancellationError(this._client.searchFilesets(
			authToken,
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
				docSha BLOB
			);
		`);

		return db;
	}

	private addOrUpdate(uri: URI, stats: { size: number; mtime: number }, docSha: Uint8Array | null) {
		this._db.prepare(`
			INSERT INTO Files (path, size, mtime, docSha)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, docSha = excluded.docSha
		`).run(uri.toString(), stats.size, stats.mtime, docSha);
	}

	private delete(uri: URI) {
		this._db.prepare('DELETE FROM Files WHERE path = ?').run(uri.toString());
	}

	private get(uri: URI): { size: number; mtime: number; docSha: Uint8Array | null } | undefined {
		const row = this._db.prepare('SELECT size, mtime, docSha FROM Files WHERE path = ?').get(uri.toString());
		if (!row) {
			return undefined;
		}

		return {
			size: row.size as number,
			mtime: row.mtime as number,
			docSha: row.docSha as Uint8Array | null
		};
	}

	private async *getFilesToIndex(): AsyncIterable<{ readonly uri: URI; readonly docSha: Uint8Array }> {
		const rows = this._db.prepare('SELECT path, size, mtime, docSha FROM Files').all() as Array<{
			path: string;
			size: number;
			mtime: number;
			docSha: Uint8Array | null;
		}>;

		for (const row of rows) {
			const uri = URI.parse(row.path);

			// Skip files that are now under code search repos
			if (!this.shouldIndexFile(uri)) {
				this.delete(uri);
				continue;
			}

			const stat = await this.safeStat(uri);
			if (!stat) {
				this.delete(uri);
				continue;
			}

			if (shouldAlwaysIgnoreFile(uri)) {
				this.delete(uri);
				continue;
			}

			if (await this.isIgnored(uri)) {
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
			}

			this.addOrUpdate(uri, stat, docSha);
			yield { uri, docSha };
		}
	}

	private async reconcileFiles(): Promise<void> {
		const allKnownFiles = new ResourceSet();
		for (const uri of this.iterateDbFiles()) {
			allKnownFiles.add(uri);
		}

		const seen = new ResourceSet();
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();

		for (const folder of workspaceFolders) {
			const paths = await this._searchService.findFilesWithDefaultExcludes(
				new RelativePattern(folder, '**/*'),
				Number.POSITIVE_INFINITY,
				CancellationToken.None
			);

			for (const uri of paths) {
				// Skip files under code search repos
				if (!this.shouldIndexFile(uri)) {
					continue;
				}

				if (shouldAlwaysIgnoreFile(uri)) {
					continue;
				}

				if (await this.isIgnored(uri)) {
					continue;
				}

				const stat = await this.safeStat(uri);
				if (!stat) {
					continue;
				}

				seen.add(uri);

				const existing = this.get(uri);
				if (!existing || existing.size !== stat.size || existing.mtime !== stat.mtime) {
					this.addOrUpdate(uri, stat, null);
				}
			}
		}

		// Remove files that no longer exist
		for (const uri of allKnownFiles) {
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
		if (!this.shouldIndexFile(uri)) {
			return;
		}

		if (shouldAlwaysIgnoreFile(uri)) {
			return;
		}

		if (await this.isIgnored(uri)) {
			return;
		}

		const stat = await this.safeStat(uri);
		if (!stat) {
			return;
		}

		this.addOrUpdate(uri, stat, null);
	}

	private async onFileChanged(uri: URI): Promise<void> {
		if (!this.shouldIndexFile(uri)) {
			return;
		}

		if (shouldAlwaysIgnoreFile(uri)) {
			return;
		}

		if (await this.isIgnored(uri)) {
			return;
		}

		const stat = await this.safeStat(uri);
		if (!stat) {
			this.delete(uri);
			return;
		}

		this.addOrUpdate(uri, stat, null);
	}

	private onFileDeleted(uri: URI): void {
		this.delete(uri);
		this.deleteFolder(uri);
	}

	private async isIgnored(uri: URI): Promise<boolean> {
		return this._ignoreService.isCopilotIgnored(uri, CancellationToken.None);
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
				// Use a relative path for the doc sha
				const workspaceFolders = this._workspaceService.getWorkspaceFolders();
				let relativePath = uri.fsPath;
				for (const folder of workspaceFolders) {
					if (isEqualOrParent(uri, folder)) {
						relativePath = uri.fsPath.slice(folder.fsPath.length + 1);
						break;
					}
				}
				return getDocSha(relativePath, new DocumentContents(data));
			} catch {
				return undefined;
			}
		});
	}

	private async getGithubAuthToken(): Promise<string | undefined> {
		return (await this._authenticationService.getGitHubSession('permissive', { silent: true }))?.accessToken
			?? (await this._authenticationService.getGitHubSession('any', { silent: true }))?.accessToken;
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
