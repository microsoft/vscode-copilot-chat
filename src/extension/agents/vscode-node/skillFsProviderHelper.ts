/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Emitter } from '../../../util/vs/base/common/event';

const SKILL_FILENAME = 'SKILL.md';
const SKILL_SCHEME = 'copilot-skill';

interface IDynamicSkillFolder {
	readonly folderName: string;
	readonly provideSkillContentBytes: () => Promise<Uint8Array>;
}

class SkillFsProvider implements vscode.FileSystemProvider {

	private readonly dynamicSkills = new Map<string, IDynamicSkillFolder>();

	private readonly _onDidChangeFile = new Emitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(
		private readonly extensionContext: IVSCodeExtensionContext,
	) {
	}

	public registerDynamicSkill(dynamicSkill: IDynamicSkillFolder): vscode.Disposable {
		this.dynamicSkills.set(dynamicSkill.folderName, dynamicSkill);

		return {
			dispose: () => {
				this.dynamicSkills.delete(dynamicSkill.folderName);
			}
		};
	}

	watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
		return { dispose: () => { } };
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const parsed = this.parseSkillUri(uri);
		if (!parsed) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		if (parsed.kind === 'root') {
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0,
			};
		}

		if (parsed.kind === 'folder') {
			if (!this.dynamicSkills.has(parsed.folderName)) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}

			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0,
			};
		}

		const dynamicSkill = this.dynamicSkills.get(parsed.folderName);
		if (!dynamicSkill) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		if (parsed.relativePath === SKILL_FILENAME) {
			const content = await dynamicSkill.provideSkillContentBytes();
			return {
				type: vscode.FileType.File,
				ctime: 0,
				mtime: Date.now(),
				size: content.length,
			};
		}

		const assetUri = this.toAssetUri(parsed.folderName, parsed.relativePath);
		return vscode.workspace.fs.stat(assetUri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const parsed = this.parseSkillUri(uri);
		if (!parsed) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		if (parsed.kind === 'root') {
			return [...this.dynamicSkills.keys()].map(folderName => [folderName, vscode.FileType.Directory]);
		}

		if (parsed.kind === 'folder') {
			if (!this.dynamicSkills.has(parsed.folderName)) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}

			const assetFolderUri = this.toAssetUri(parsed.folderName, '');
			try {
				return await vscode.workspace.fs.readDirectory(assetFolderUri);
			} catch {
				return [[SKILL_FILENAME, vscode.FileType.File]];
			}
		}

		const dynamicSkill = this.dynamicSkills.get(parsed.folderName);
		if (!dynamicSkill) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		const assetFolderUri = this.toAssetUri(parsed.folderName, parsed.relativePath);
		return vscode.workspace.fs.readDirectory(assetFolderUri);
	}

	createDirectory(_uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const parsed = this.parseSkillUri(uri);
		if (!parsed || parsed.kind !== 'file') {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		const dynamicSkill = this.dynamicSkills.get(parsed.folderName);
		if (!dynamicSkill) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		if (parsed.relativePath === SKILL_FILENAME) {
			return dynamicSkill.provideSkillContentBytes();
		}

		const assetUri = this.toAssetUri(parsed.folderName, parsed.relativePath);
		return vscode.workspace.fs.readFile(assetUri);
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

	private toAssetUri(folderName: string, relativePath: string): vscode.Uri {
		const segments = relativePath.split('/').filter(Boolean);
		return vscode.Uri.joinPath(
			this.extensionContext.extensionUri,
			'assets',
			'prompts',
			'skills',
			folderName,
			...segments,
		);
	}

	private parseSkillUri(uri: vscode.Uri):
		| { kind: 'root' }
		| { kind: 'folder'; folderName: string }
		| { kind: 'file'; folderName: string; relativePath: string }
		| undefined {
		if (uri.scheme !== SKILL_SCHEME) {
			return undefined;
		}

		const segments = uri.path.split('/').filter(Boolean);
		if (segments.length === 0) {
			return { kind: 'root' };
		}

		if (segments.length === 1) {
			return { kind: 'folder', folderName: segments[0] };
		}

		return {
			kind: 'file',
			folderName: segments[0],
			relativePath: segments.slice(1).join('/'),
		};
	}
}

let sharedFsProvider:
	| {
		provider: SkillFsProvider;
		registration: vscode.Disposable;
	}
	| undefined;

function getOrCreateSharedFsProvider(
	extensionContext: IVSCodeExtensionContext,
): SkillFsProvider {
	if (!sharedFsProvider) {
		const provider = new SkillFsProvider(extensionContext);
		const registration = vscode.workspace.registerFileSystemProvider(SKILL_SCHEME, provider, { isReadonly: true });
		sharedFsProvider = { provider, registration };
	}

	return sharedFsProvider.provider;
}

export function registerDynamicSkillFolder(
	extensionContext: IVSCodeExtensionContext,
	folderName: string,
	provideSkillContentBytes: () => Promise<Uint8Array>,
): { readonly skillUri: vscode.Uri; readonly disposable: vscode.Disposable } {
	const provider = getOrCreateSharedFsProvider(extensionContext);
	const disposable = provider.registerDynamicSkill({
		folderName,
		provideSkillContentBytes,
	});

	return {
		skillUri: vscode.Uri.from({ scheme: SKILL_SCHEME, path: `/${folderName}/${SKILL_FILENAME}` }),
		disposable,
	};
}
