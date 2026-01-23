/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { URI } from '../../../../util/vs/base/common/uri';

/**
 * Resolver function that returns URIs to track.
 * Called each time a snapshot is taken to get current paths.
 */
export type SettingsPathResolver = () => URI[];

/**
 * Tracks modification times of settings files (CLAUDE.md, hooks, etc.)
 * to detect when a session should be restarted to pick up changes.
 *
 * This is designed to be easily expandable - just register additional
 * path resolvers for new file types to track.
 */
export class ClaudeSettingsChangeTracker {
	private readonly _pathResolvers: SettingsPathResolver[] = [];
	private _snapshot: Map<string, number> = new Map();

	constructor(
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * Registers a path resolver that provides URIs to track.
	 * Resolvers are called each time a snapshot is taken.
	 *
	 * @param resolver Function that returns URIs to track
	 */
	registerPathResolver(resolver: SettingsPathResolver): void {
		this._pathResolvers.push(resolver);
	}

	/**
	 * Takes a snapshot of modification times for all tracked files.
	 * Call this when starting or restarting a session.
	 */
	async takeSnapshot(): Promise<void> {
		this._snapshot.clear();

		const allPaths = this._pathResolvers.flatMap(resolver => resolver());

		for (const uri of allPaths) {
			try {
				const stat = await this.fileSystemService.stat(uri);
				this._snapshot.set(uri.toString(), stat.mtime);
				this.logService.trace(`[ClaudeSettingsChangeTracker] Snapshot: ${uri.fsPath} mtime=${stat.mtime}`);
			} catch {
				// File doesn't exist yet - record as 0 so we detect if it's created
				this._snapshot.set(uri.toString(), 0);
				this.logService.trace(`[ClaudeSettingsChangeTracker] Snapshot: ${uri.fsPath} (does not exist)`);
			}
		}
	}

	/**
	 * Async generator that yields changed files one at a time.
	 * Allows early termination when only checking for existence of changes.
	 */
	private async *_changedFilesGenerator(): AsyncGenerator<URI> {
		const allPaths = this._pathResolvers.flatMap(resolver => resolver());

		for (const uri of allPaths) {
			const uriString = uri.toString();
			const snapshotMtime = this._snapshot.get(uriString);

			try {
				const stat = await this.fileSystemService.stat(uri);
				if (snapshotMtime === undefined) {
					// New file that wasn't in snapshot - treat as changed
					this.logService.trace(`[ClaudeSettingsChangeTracker] New file detected: ${uri.fsPath}`);
					yield uri;
				} else if (stat.mtime > snapshotMtime) {
					this.logService.trace(`[ClaudeSettingsChangeTracker] Changed: ${uri.fsPath} (${snapshotMtime} -> ${stat.mtime})`);
					yield uri;
				}
			} catch {
				// File doesn't exist now
				if (snapshotMtime !== undefined && snapshotMtime > 0) {
					// File was deleted - treat as changed
					this.logService.trace(`[ClaudeSettingsChangeTracker] Deleted: ${uri.fsPath}`);
					yield uri;
				}
			}
		}
	}

	/**
	 * Checks if any files have changed. Returns early on first change found.
	 *
	 * @returns true if any tracked file has been modified since the last snapshot
	 */
	async hasChanges(): Promise<boolean> {
		for await (const _uri of this._changedFilesGenerator()) {
			return true;
		}
		return false;
	}
}
