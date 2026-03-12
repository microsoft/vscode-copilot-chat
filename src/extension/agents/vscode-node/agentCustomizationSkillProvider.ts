/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { BaseSkillProvider } from './baseSkillProvider';

const USER_PROMPTS_FOLDER_PLACEHOLDER = '{{USER_PROMPTS_FOLDER}}';

/**
 * Provides the built-in agent-customization skill that teaches agents
 * how to work with VS Code's customization system (instructions, prompts, agents, skills).
 */
export class AgentCustomizationSkillProvider extends BaseSkillProvider {

	private cachedContent: Uint8Array | undefined;

	constructor(
		@ILogService logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
	) {
		super(logService, extensionContext, 'agent-customization');
	}

	private getUserPromptsFolder(): string {
		const globalStorageUri = this.extensionContext.globalStorageUri;
		const userFolderUri = vscode.Uri.joinPath(globalStorageUri, '..', '..');
		const userPromptsFolderUri = vscode.Uri.joinPath(userFolderUri, 'prompts');

		return userPromptsFolderUri.fsPath;
	}

	protected override processTemplate(templateContent: string): string {
		const userPromptsFolder = this.getUserPromptsFolder();
		this.logService.trace(`[AgentCustomizationSkillProvider] Injected user prompts folder: ${userPromptsFolder}`);
		return templateContent.replace(USER_PROMPTS_FOLDER_PLACEHOLDER, userPromptsFolder);
	}

	protected override async getSkillContentBytes(): Promise<Uint8Array> {
		if (this.cachedContent) {
			return this.cachedContent;
		}

		this.cachedContent = await super.getSkillContentBytes();
		return this.cachedContent;
	}
}
