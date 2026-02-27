/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { PERSONAL_SKILL_FOLDERS, SKILL_FILENAME, SKILLS_LOCATION_KEY, USE_AGENT_SKILLS_SETTING, WORKSPACE_SKILL_FOLDERS } from '../../../platform/customInstructions/common/promptTypes';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Delayer } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { isAbsolute } from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';

const USER_SKILL_SCHEME = 'copilot-user-skill';
const CACHE_INVALIDATION_DELAY = 500;

interface DiscoveredSkill {
	/** Display name derived from the skill directory name. */
	readonly name: string;
	/** Real filesystem URI to the SKILL.md file. */
	readonly realUri: URI;
	/** Virtual URI served by our FileSystemProvider. */
	readonly virtualUri: vscode.Uri;
}

/**
 * Discovers user-defined skills from personal, workspace, and config-defined
 * skill folders, then surfaces them as slash commands in the VS Code chat picker.
 *
 * Each skill is a directory containing a SKILL.md file. The provider registers
 * a virtual FileSystemProvider so VS Code's fileService.readFile() can resolve
 * skill content during prompt parsing.
 */
export class UserDefinedSkillProvider extends Disposable implements vscode.ChatSkillProvider, vscode.FileSystemProvider {

	private _skillsPromise: Promise<DiscoveredSkill[]> | undefined;
	private readonly _virtualUriToRealUri = new Map<string, URI>();

	private readonly _onDidChangeFile = this._register(new Emitter<vscode.FileChangeEvent[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	readonly onDidChangeSkills = this._onDidChangeSkills.event;

	private readonly _invalidateDelayer: Delayer<void>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		super();

		this._invalidateDelayer = this._register(new Delayer(CACHE_INVALIDATION_DELAY));

		if (vscode.workspace && typeof vscode.workspace.registerFileSystemProvider === 'function') {
			this._register(vscode.workspace.registerFileSystemProvider(USER_SKILL_SCHEME, this, { isReadonly: true }));
		}

		// Invalidate cache on config / workspace changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(USE_AGENT_SKILLS_SETTING) || e.affectsConfiguration(SKILLS_LOCATION_KEY)) {
				this._invalidateCache();
			}
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._invalidateCache();
		}));
	}

	// #region Cache management

	private _invalidateCache(): void {
		this._invalidateDelayer.trigger(() => {
			this._skillsPromise = undefined;
			this._virtualUriToRealUri.clear();
			this._onDidChangeSkills.fire();
			this._onDidChangeFile.fire([]);
		});
	}

	// #endregion

	// #region FileSystemProvider

	watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
		return { dispose: () => { } };
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const realUri = await this._resolveRealUri(uri);
		if (realUri) {
			return this.fileSystemService.stat(realUri);
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(_uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		return [];
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const realUri = await this._resolveRealUri(uri);
		if (realUri) {
			return this.fileSystemService.readFile(realUri);
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	createDirectory(_uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean }): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	delete(_uri: vscode.Uri, _options: { readonly recursive: boolean }): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean }): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	// #endregion

	// #region ChatSkillProvider

	async provideSkills(
		_context: unknown,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		if (!this.configurationService.getNonExtensionConfig<boolean>(USE_AGENT_SKILLS_SETTING)) {
			return [];
		}

		try {
			const skills = await this._getSkills();
			this.logService.trace(`[UserDefinedSkillProvider] Providing ${skills.length} user-defined skills`);
			return skills.map(s => ({ uri: s.virtualUri }));
		} catch (error) {
			this.logService.error(`[UserDefinedSkillProvider] Error providing skills: ${error}`);
			return [];
		}
	}

	// #endregion

	// #region Discovery

	private _getSkills(): Promise<DiscoveredSkill[]> {
		if (!this._skillsPromise) {
			this._skillsPromise = this._discoverSkills().then(skills => {
				this._virtualUriToRealUri.clear();
				for (const skill of skills) {
					this._virtualUriToRealUri.set(skill.virtualUri.toString(), skill.realUri);
				}
				return skills;
			}, error => {
				this._skillsPromise = undefined;
				throw error;
			});
		}
		return this._skillsPromise;
	}

	private async _discoverSkills(): Promise<DiscoveredSkill[]> {
		const skillFolderUris = this._getSkillFolderUris();
		const skills: DiscoveredSkill[] = [];
		let index = 0;

		for (const folderUri of skillFolderUris) {
			try {
				const entries = await this.fileSystemService.readDirectory(folderUri);
				for (const [name, type] of entries) {
					if (type !== FileType.Directory) {
						continue;
					}
					// Check for SKILL.md (case-insensitive)
					const skillDirUri = URI.joinPath(folderUri, name);
					if (await this._hasSkillFile(skillDirUri)) {
						const skillFileUri = URI.joinPath(skillDirUri, SKILL_FILENAME);
						const virtualUri = vscode.Uri.from({
							scheme: USER_SKILL_SCHEME,
							path: `/${index}/${name}/${SKILL_FILENAME}`
						});
						skills.push({ name, realUri: skillFileUri, virtualUri });
						index++;
					}
				}
			} catch {
				// Folder doesn't exist - skip silently
			}
		}

		return skills;
	}

	private _getSkillFolderUris(): URI[] {
		const uris: URI[] = [];

		// Personal skill folders
		for (const folder of PERSONAL_SKILL_FOLDERS) {
			uris.push(URI.joinPath(this.envService.userHome, folder));
		}

		// Workspace skill folders
		for (const workspaceFolder of this.workspaceService.getWorkspaceFolders()) {
			for (const folder of WORKSPACE_SKILL_FOLDERS) {
				uris.push(URI.joinPath(workspaceFolder, folder));
			}
		}

		// Config-defined skill locations
		const locations = this.configurationService.getNonExtensionConfig<Record<string, boolean>>(SKILLS_LOCATION_KEY);
		if (locations && typeof locations === 'object') {
			const userHome = this.envService.userHome;
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			for (const key in locations) {
				const location = key.trim();
				if (locations[key] !== true) {
					continue;
				}
				if (location.startsWith('~/')) {
					uris.push(URI.joinPath(userHome, location.substring(2)));
				} else if (isAbsolute(location)) {
					uris.push(URI.file(location));
				} else {
					for (const workspaceFolder of workspaceFolders) {
						uris.push(URI.joinPath(workspaceFolder, location));
					}
				}
			}
		}

		return uris;
	}

	private async _hasSkillFile(dirUri: URI): Promise<boolean> {
		try {
			const entries = await this.fileSystemService.readDirectory(dirUri);
			return entries.some(([name, type]) =>
				type === FileType.File && name.toLowerCase() === SKILL_FILENAME.toLowerCase()
			);
		} catch {
			return false;
		}
	}

	private async _resolveRealUri(virtualUri: vscode.Uri): Promise<URI | undefined> {
		await this._getSkills();
		return this._virtualUriToRealUri.get(virtualUri.toString());
	}

	// #endregion
}
