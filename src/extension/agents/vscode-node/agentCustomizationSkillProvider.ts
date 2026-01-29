/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const SKILL_FOLDER_NAME = 'agent-customization';
const SKILL_FILENAME = 'SKILL.md';
const SKILL_SCHEME = 'copilot-skill';

/**
 * Placeholder in SKILL.md that will be replaced with the actual user prompts folder path.
 */
const USER_PROMPTS_FOLDER_PLACEHOLDER = '{{USER_PROMPTS_FOLDER}}';

/**
 * Provides the built-in agent-customization skill that teaches agents
 * how to work with VS Code's customization system (instructions, prompts, agents, skills).
 *
 * Uses a FileSystemProvider (instead of TextDocumentContentProvider) so that VS Code's
 * fileService.readFile() can read the skill content during prompt parsing, not just when
 * the file is opened in an editor.
 */
export class AgentCustomizationSkillProvider extends Disposable implements vscode.ChatSkillProvider, vscode.FileSystemProvider {

	private readonly _skillContentUri: vscode.Uri;
	private _cachedContent: Uint8Array | undefined;

	private readonly _onDidChangeFile = this._register(new Emitter<vscode.FileChangeEvent[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();

		// Create a virtual URI for the dynamically generated skill content
		this._skillContentUri = vscode.Uri.from({
			scheme: SKILL_SCHEME,
			path: `/${SKILL_FOLDER_NAME}/${SKILL_FILENAME}`
		});

		// Register a FileSystemProvider to serve the dynamic skill content.
		// This is required because VS Code's promptsService uses fileService.readFile()
		// to read skill content, which only works with FileSystemProvider, not TextDocumentContentProvider.
		this._register(vscode.workspace.registerFileSystemProvider(SKILL_SCHEME, this, { isReadonly: true }));
	}

	// #region FileSystemProvider implementation

	watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
		// No need to watch - content is static after first load
		return { dispose: () => { } };
	}

	/**
	 * Converts a virtual URI path to the corresponding physical URI in the extension assets.
	 * Virtual: /agent-customization/primitives/agents.md
	 * Physical: extensionUri/assets/prompts/skills/agent-customization/primitives/agents.md
	 */
	private _toAssetUri(virtualPath: string): vscode.Uri | undefined {
		// Ensure the path is within our skill folder
		const prefix = `/${SKILL_FOLDER_NAME}`;
		if (!virtualPath.startsWith(prefix)) {
			return undefined;
		}

		// Get the relative path after /agent-customization
		const relativePath = virtualPath.substring(prefix.length);

		// Build the full asset path
		return vscode.Uri.joinPath(
			this.extensionContext.extensionUri,
			'assets',
			'prompts',
			'skills',
			SKILL_FOLDER_NAME,
			...relativePath.split('/').filter(Boolean)
		);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		// Handle the dynamic SKILL.md file
		if (uri.path === `/${SKILL_FOLDER_NAME}/${SKILL_FILENAME}`) {
			const content = await this._getSkillContentBytes();
			return {
				type: vscode.FileType.File,
				ctime: 0,
				mtime: Date.now(),
				size: content.length
			};
		}

		// Handle root and skill folder directories
		if (uri.path === `/${SKILL_FOLDER_NAME}` || uri.path === '/') {
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0
			};
		}

		// Handle nested files/directories (e.g., /agent-customization/primitives/agents.md)
		const assetUri = this._toAssetUri(uri.path);
		if (assetUri) {
			try {
				return await vscode.workspace.fs.stat(assetUri);
			} catch {
				// Fall through to FileNotFound
			}
		}

		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		if (uri.path === '/' || uri.path === '') {
			return [[SKILL_FOLDER_NAME, vscode.FileType.Directory]];
		}

		// For paths within the skill folder, enumerate actual directory contents
		const assetUri = this._toAssetUri(uri.path);
		if (assetUri) {
			try {
				return await vscode.workspace.fs.readDirectory(assetUri);
			} catch {
				// Fall through to empty result
			}
		}

		return [];
	}

	createDirectory(_uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions('Readonly file system');
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		// The root SKILL.md has dynamic content (placeholder injection)
		if (uri.path === `/${SKILL_FOLDER_NAME}/${SKILL_FILENAME}`) {
			return this._getSkillContentBytes();
		}

		// All other files are read directly from the assets folder
		const assetUri = this._toAssetUri(uri.path);
		if (assetUri) {
			try {
				return await vscode.workspace.fs.readFile(assetUri);
			} catch {
				// Fall through to FileNotFound
			}
		}

		throw vscode.FileSystemError.FileNotFound(uri);
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

	/**
	 * Gets the user prompts folder path from the extension context's globalStorageUri.
	 * The globalStorageUri is typically: `.../User/globalStorage/<extension-id>/`
	 * The user prompts folder is: `.../User/prompts/`
	 */
	private _getUserPromptsFolder(): string {
		const globalStorageUri = this.extensionContext.globalStorageUri;

		// Navigate up from globalStorage/<extension-id>/ to User/ and then to prompts/
		// globalStorageUri: file:///Users/.../User/globalStorage/github.copilot-chat/
		// We want: file:///Users/.../User/prompts/
		const userFolderUri = vscode.Uri.joinPath(globalStorageUri, '..', '..');
		const userPromptsFolderUri = vscode.Uri.joinPath(userFolderUri, 'prompts');

		return userPromptsFolderUri.fsPath;
	}

	/**
	 * Reads the SKILL.md template and injects the user prompts folder path.
	 * Returns bytes for use by the FileSystemProvider.
	 */
	private async _getSkillContentBytes(): Promise<Uint8Array> {
		if (this._cachedContent) {
			return this._cachedContent;
		}

		try {
			// Build the URI to the original skill file within the extension
			const skillTemplateUri = vscode.Uri.joinPath(
				this.extensionContext.extensionUri,
				'assets',
				'prompts',
				'skills',
				SKILL_FOLDER_NAME,
				SKILL_FILENAME
			);

			// Read the template content
			const templateBytes = await vscode.workspace.fs.readFile(skillTemplateUri);
			const templateContent = new TextDecoder().decode(templateBytes);

			// Replace the placeholder with the actual user prompts folder path
			const userPromptsFolder = this._getUserPromptsFolder();
			const processedContent = templateContent.replace(USER_PROMPTS_FOLDER_PLACEHOLDER, userPromptsFolder);
			this._cachedContent = new TextEncoder().encode(processedContent);

			this.logService.trace(`[AgentCustomizationSkillProvider] Injected user prompts folder: ${userPromptsFolder}`);

			return this._cachedContent;
		} catch (error) {
			this.logService.error(`[AgentCustomizationSkillProvider] Error reading skill template: ${error}`);
			return new Uint8Array();
		}
	}

	async provideSkills(
		_context: unknown,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		try {
			if (token.isCancellationRequested) {
				return [];
			}

			this.logService.trace(`[AgentCustomizationSkillProvider] Providing skill at ${this._skillContentUri.toString()}`);

			return [{ uri: this._skillContentUri }];
		} catch (error) {
			this.logService.error(`[AgentCustomizationSkillProvider] Error providing skills: ${error}`);
			return [];
		}
	}
}
