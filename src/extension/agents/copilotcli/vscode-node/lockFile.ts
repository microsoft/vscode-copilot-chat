/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ILogger } from '../../../../platform/log/common/logService';
import { getCopilotCliStateDir } from './cliHelpers';

export interface LockFileInfo {
	socketPath: string;
	scheme: string;
	headers: Record<string, string>;
	pid: number;
	ideName: string;
	timestamp: number;
	workspaceFolders: string[];
}

export class LockFileHandle {
	private readonly lockFilePath: string;
	private readonly serverUri: vscode.Uri;
	private readonly headers: Record<string, string>;
	private readonly timestamp: number;
	private readonly logger: ILogger;

	constructor(lockFilePath: string, serverUri: vscode.Uri, headers: Record<string, string>, timestamp: number, logger: ILogger) {
		this.lockFilePath = lockFilePath;
		this.serverUri = serverUri;
		this.headers = headers;
		this.timestamp = timestamp;
		this.logger = logger;
	}

	get path(): string {
		return this.lockFilePath;
	}

	update(): void {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];

			const lockInfo: LockFileInfo = {
				socketPath: this.serverUri.path,
				scheme: this.serverUri.scheme,
				headers: this.headers,
				pid: process.pid,
				ideName: vscode.env.appName,
				timestamp: this.timestamp,
				workspaceFolders: workspaceFolders,
			};

			fs.writeFileSync(this.lockFilePath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });
			this.logger.trace(`Lock file updated: ${this.lockFilePath}`);
		} catch (error) {
			this.logger.debug(`Failed to update lock file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	remove(): void {
		try {
			if (fs.existsSync(this.lockFilePath)) {
				fs.unlinkSync(this.lockFilePath);
				this.logger.debug(`Lock file removed: ${this.lockFilePath}`);
			}
		} catch (error) {
			this.logger.debug(`Failed to remove lock file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export async function createLockFile(serverUri: vscode.Uri, headers: Record<string, string>, logger: ILogger): Promise<LockFileHandle> {
	const copilotDir = getCopilotCliStateDir();
	logger.trace(`Creating lock file in: ${copilotDir}`);

	if (!fs.existsSync(copilotDir)) {
		fs.mkdirSync(copilotDir, { recursive: true, mode: 0o700 });
		logger.debug(`Created Copilot state directory: ${copilotDir}`);
	}

	const uuid = crypto.randomUUID();
	const lockFilePath = path.join(copilotDir, `${uuid}.lock`);

	const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
	const timestamp = Date.now();

	const lockInfo: LockFileInfo = {
		socketPath: serverUri.path,
		scheme: serverUri.scheme,
		headers: headers,
		pid: process.pid,
		ideName: vscode.env.appName,
		timestamp: timestamp,
		workspaceFolders: workspaceFolders,
	};

	fs.writeFileSync(lockFilePath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });
	logger.debug(`Created lock file: ${lockFilePath}`);

	return new LockFileHandle(lockFilePath, serverUri, headers, timestamp, logger);
}

/**
 * Checks if a process with the given PID is still running.
 * Note: Signal 0 is a special "null signal" that doesn't actually kill the process -
 * it only checks if the process exists and we have permission to signal it.
 */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Cleans up stale lockfiles where the associated process is no longer running.
 * Returns the number of lockfiles cleaned up.
 */
export function cleanupStaleLockFiles(logger: ILogger): number {
	const copilotDir = getCopilotCliStateDir();

	if (!fs.existsSync(copilotDir)) {
		return 0;
	}

	let cleanedCount = 0;
	const files = fs.readdirSync(copilotDir);

	for (const file of files) {
		if (file.endsWith('.lock')) {
			const filePath = path.join(copilotDir, file);
			try {
				const content = fs.readFileSync(filePath, 'utf-8');
				const info = JSON.parse(content) as LockFileInfo;

				if (!isProcessRunning(info.pid)) {
					fs.unlinkSync(filePath);
					cleanedCount++;
					logger.debug(`Removed stale lock file for PID ${info.pid}: ${filePath}`);
				}
			} catch {
				// Skip files that can't be read or parsed
			}
		}
	}

	return cleanedCount;
}
