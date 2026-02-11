/*---------------------------------------------------------------------------------------------
 *  Local-Only Ignore Service
 *  Reads .copilotignore and .aiignore files from workspace folders.
 *  No remote content exclusion (CAPI) dependency.
 *--------------------------------------------------------------------------------------------*/

import { workspace } from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { RelativePattern } from '../../filesystem/common/fileTypes';
import { ILogService } from '../../log/common/logService';
import { BaseSearchServiceImpl } from '../../search/vscode/baseSearchServiceImpl';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { IIgnoreService } from '../../ignore/common/ignoreService';
import { IgnoreFile } from '../../ignore/node/ignoreFile';

const COPILOT_IGNORE_FILE_NAME = '.copilotignore';
const AI_IGNORE_FILE_NAME = '.aiignore';

export class LocalIgnoreService implements IIgnoreService {

	declare readonly _serviceBrand: undefined;

	private readonly _copilotIgnoreFiles = new IgnoreFile();
	private readonly _searchService = new BaseSearchServiceImpl();
	private _disposables: IDisposable[] = [];
	private _init: Promise<void> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IFileSystemService private readonly _fs: IFileSystemService,
	) {
		this._installListeners();
	}

	get isEnabled(): boolean {
		return true;
	}

	get isRegexExclusionsEnabled(): boolean {
		return false;
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}

	init(): Promise<void> {
		this._init ??= (async () => {
			for (const folder of this._workspaceService.getWorkspaceFolders()) {
				await this._addWorkspace(folder);
			}
		})();
		return this._init;
	}

	async isCopilotIgnored(file: URI, _token?: CancellationToken): Promise<boolean> {
		return this._copilotIgnoreFiles.isIgnored(file);
	}

	async asMinimatchPattern(): Promise<string | undefined> {
		const patterns = this._copilotIgnoreFiles.asMinimatchPatterns();
		if (patterns.length === 0) {
			return undefined;
		} else if (patterns.length === 1) {
			return patterns[0];
		}
		return `{${patterns.join(',')}}`;
	}

	private _installListeners(): void {
		this._disposables.push(workspace.onDidChangeWorkspaceFolders(e => {
			for (const folder of e.removed) {
				this._copilotIgnoreFiles.removeWorkspace(folder.uri);
			}
			for (const folder of e.added) {
				this._addWorkspace(folder.uri);
			}
		}));

		this._disposables.push(
			workspace.onDidSaveTextDocument(async doc => {
				if (this._isIgnoreFile(doc.uri)) {
					const contents = (await workspace.fs.readFile(doc.uri)).toString();
					const folder = workspace.getWorkspaceFolder(doc.uri);
					this._copilotIgnoreFiles.setIgnoreFile(folder?.uri, doc.uri, contents);
				}
			}),
			workspace.onDidDeleteFiles(e => {
				for (const f of e.files) {
					this._copilotIgnoreFiles.removeIgnoreFile(f);
				}
			}),
			workspace.onDidRenameFiles(async e => {
				for (const f of e.files) {
					if (this._isIgnoreFile(f.newUri)) {
						const contents = (await workspace.fs.readFile(f.newUri)).toString();
						this._copilotIgnoreFiles.removeIgnoreFile(f.oldUri);
						const folder = workspace.getWorkspaceFolder(f.newUri);
						this._copilotIgnoreFiles.setIgnoreFile(folder?.uri, f.newUri, contents);
					}
				}
			})
		);
	}

	private _isIgnoreFile(fileUri: URI): boolean {
		return fileUri.path.endsWith(COPILOT_IGNORE_FILE_NAME) || fileUri.path.endsWith(AI_IGNORE_FILE_NAME);
	}

	private async _addWorkspace(workspaceUri: URI): Promise<void> {
		if (workspaceUri.scheme !== 'file') {
			return;
		}

		// Load both .copilotignore and .aiignore files
		for (const fileName of [COPILOT_IGNORE_FILE_NAME, AI_IGNORE_FILE_NAME]) {
			try {
				const files: URI[] = await this._searchService.findFilesWithDefaultExcludes(
					new RelativePattern(workspaceUri, `${fileName}`),
					undefined,
					CancellationToken.None
				);
				for (const file of files) {
					const contents = (await this._fs.readFile(file)).toString();
					this._copilotIgnoreFiles.setIgnoreFile(workspaceUri, file, contents);
				}
			} catch (err) {
				this._logService.warn(`Failed to load ${fileName}: ${(err as Error).message}`);
			}
		}
	}
}
