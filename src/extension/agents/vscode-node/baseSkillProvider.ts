/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SKILL_FILENAME } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { registerDynamicSkillFolder } from './skillFsProviderHelper';

/**
 * Base class for skill providers that serve a template-based SKILL.md with placeholder replacements.
 *
 * Handles constructor registration with the dynamic skill folder filesystem,
 * template loading from `assets/prompts/skills/<folderName>/SKILL.md`,
 * encoding, error handling, and the `provideSkills` contract.
 *
 * Subclasses implement {@link processTemplate} to perform their own placeholder replacements.
 */
export abstract class BaseSkillProvider extends Disposable implements vscode.ChatSkillProvider {

	protected readonly skillContentUri: vscode.Uri;
	private readonly _skillFolderName: string;

	constructor(
		protected readonly logService: ILogService,
		protected readonly extensionContext: IVSCodeExtensionContext,
		skillFolderName: string,
	) {
		super();
		this._skillFolderName = skillFolderName;

		const registration = registerDynamicSkillFolder(
			this.extensionContext,
			skillFolderName,
			() => this.getSkillContentBytes(),
		);
		this.skillContentUri = registration.skillUri;
		this._register(registration.disposable);
	}

	/**
	 * Process the raw template string with placeholder replacements.
	 * Called each time the skill content is requested (unless the subclass caches).
	 */
	protected abstract processTemplate(templateContent: string): string | Promise<string>;

	protected async getSkillContentBytes(): Promise<Uint8Array> {
		try {
			const skillTemplateUri = vscode.Uri.joinPath(
				this.extensionContext.extensionUri,
				'assets',
				'prompts',
				'skills',
				this._skillFolderName,
				SKILL_FILENAME,
			);

			const templateBytes = await vscode.workspace.fs.readFile(skillTemplateUri);
			const templateContent = new TextDecoder().decode(templateBytes);
			const processedContent = await this.processTemplate(templateContent);
			return new TextEncoder().encode(processedContent);
		} catch (error) {
			this.logService.error(`[${this.constructor.name}] Error reading skill template: ${error}`);
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
