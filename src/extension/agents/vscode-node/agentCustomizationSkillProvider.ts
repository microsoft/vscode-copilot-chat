/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { registerDynamicSkillFolder } from './skillFsProviderHelper';

const SKILL_FOLDER_NAME = 'agent-customization';
const USER_PROMPTS_FOLDER_PLACEHOLDER = '{{USER_PROMPTS_FOLDER}}';

/**
 * Provides the built-in agent-customization skill that teaches agents
 * how to work with VS Code's customization system (instructions, prompts, agents, skills).
 */
export class AgentCustomizationSkillProvider extends Disposable implements vscode.ChatSkillProvider {

	private readonly skillContentUri: vscode.Uri;
	private cachedContent: Uint8Array | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();

		const registration = registerDynamicSkillFolder(
			this.extensionContext,
			SKILL_FOLDER_NAME,
			() => this.getSkillContentBytes(),
		);
		this.skillContentUri = registration.skillUri;
		this._register(registration.disposable);
	}

	private getUserPromptsFolder(): string {
		const globalStorageUri = this.extensionContext.globalStorageUri;
		const userFolderUri = vscode.Uri.joinPath(globalStorageUri, '..', '..');
		const userPromptsFolderUri = vscode.Uri.joinPath(userFolderUri, 'prompts');

		return userPromptsFolderUri.fsPath;
	}

	private async getSkillContentBytes(): Promise<Uint8Array> {
		if (this.cachedContent) {
			return this.cachedContent;
		}

		try {
			const skillTemplateUri = vscode.Uri.joinPath(
				this.extensionContext.extensionUri,
				'assets',
				'prompts',
				'skills',
				SKILL_FOLDER_NAME,
				'SKILL.md'
			);

			const templateBytes = await vscode.workspace.fs.readFile(skillTemplateUri);
			const templateContent = new TextDecoder().decode(templateBytes);
			const userPromptsFolder = this.getUserPromptsFolder();
			const processedContent = templateContent.replace(USER_PROMPTS_FOLDER_PLACEHOLDER, userPromptsFolder);
			this.cachedContent = new TextEncoder().encode(processedContent);

			this.logService.trace(`[AgentCustomizationSkillProvider] Injected user prompts folder: ${userPromptsFolder}`);
			return this.cachedContent;
		} catch (error) {
			this.logService.error(`[AgentCustomizationSkillProvider] Error reading skill template: ${error}`);
			return new Uint8Array();
		}
	}

	async provideSkills(_context: unknown, token: vscode.CancellationToken): Promise<vscode.ChatResource[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		return [{ uri: this.skillContentUri }];
	}
}
