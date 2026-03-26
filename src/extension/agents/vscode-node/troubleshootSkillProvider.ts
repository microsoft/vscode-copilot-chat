/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { BaseSkillProvider } from './baseSkillProvider';

export class TroubleshootSkillProvider extends BaseSkillProvider {

	private static readonly CACHE_DIR = 'skills';
	private static readonly SKILL_FOLDER = 'troubleshoot';

	private _diskSkillUri: vscode.Uri | undefined;

	constructor(
		@ILogService logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		super(logService, extensionContext, 'troubleshoot');
	}

	protected override processTemplate(templateContent: string): string {
		// Template is now fully static — no placeholder replacement needed
		return templateContent;
	}

	override async provideSkills(_context: unknown, token: vscode.CancellationToken): Promise<vscode.ChatResource[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		const resources: vscode.ChatResource[] = [
			// copilot-skill:// URI for VS Code local sessions (backward compat for readFileTool/promptFile session-log resolution)
			{ uri: this.skillContentUri },
		];

		// file:// URI for CLI discovery (Copilot CLI and Claude CLI)
		const diskUri = await this.ensureDiskSkill();
		if (diskUri) {
			resources.push({ uri: diskUri });
		}

		return resources;
	}

	private async ensureDiskSkill(): Promise<vscode.Uri | undefined> {
		if (this._diskSkillUri) {
			return this._diskSkillUri;
		}

		try {
			const cacheDir = vscode.Uri.joinPath(
				this.extensionContext.globalStorageUri,
				TroubleshootSkillProvider.CACHE_DIR,
				TroubleshootSkillProvider.SKILL_FOLDER,
			);

			// Ensure directory exists
			try {
				await this.fileSystemService.stat(cacheDir);
			} catch {
				await this.fileSystemService.createDirectory(cacheDir);
			}

			const fileUri = vscode.Uri.joinPath(cacheDir, SKILL_FILENAME);
			const content = await this.getSkillContentBytes();
			await this.fileSystemService.writeFile(fileUri, content);
			this._diskSkillUri = fileUri;
			this.logService.trace(`[TroubleshootSkillProvider] Wrote skill file: ${fileUri.toString()}`);
			return fileUri;
		} catch (error) {
			this.logService.error(`[TroubleshootSkillProvider] Failed to write skill to disk: ${error}`);
			return undefined;
		}
	}
}
