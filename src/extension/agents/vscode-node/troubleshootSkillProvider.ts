/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { registerDynamicSkillFolder } from './skillFsProviderHelper';

const SKILL_FOLDER_NAME = 'troubleshoot';
const RUNTIME_CONTEXT_PLACEHOLDER = '{{DEBUG_LOG_RUNTIME_CONTEXT}}';

export class TroubleshootSkillProvider extends Disposable implements vscode.ChatSkillProvider {

	private readonly skillContentUri: vscode.Uri;

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

	private getWorkspaceHashFromStorageUri(): string | undefined {
		const storageUri = this.extensionContext.storageUri;
		if (!storageUri) {
			return undefined;
		}

		const segments = storageUri.path.split('/').filter(Boolean);
		const workspaceStorageIndex = segments.lastIndexOf('workspaceStorage');
		if (workspaceStorageIndex >= 0 && workspaceStorageIndex + 1 < segments.length) {
			return segments[workspaceStorageIndex + 1];
		}

		return undefined;
	}

	private getRuntimeContext(): string {
		const workspaceHash = this.getWorkspaceHashFromStorageUri();

		const lines: string[] = [];
		lines.push('## Runtime Log Context');
		lines.push('');
		if (workspaceHash) {
			lines.push('- Workspace hash: `' + workspaceHash + '`');
		} else {
			lines.push('- Workspace hash: unavailable in this environment');
		}

		// Provide the debug-logs directory path so the agent can find log files
		const storageUri = this.extensionContext.storageUri;
		if (storageUri) {
			const debugLogsDir = vscode.Uri.joinPath(storageUri, 'debug-logs').fsPath;
			lines.push('- Debug-logs directory: `' + debugLogsDir + '`');
			lines.push('- Current session log file: `{{CURRENT_SESSION_LOG}}`');
		} else {
			lines.push('- Debug-logs directory: unavailable in this environment');
		}

		return lines.join('\n');
	}

	private async getSkillContentBytes(): Promise<Uint8Array> {
		try {
			const skillTemplateUri = vscode.Uri.joinPath(
				this.extensionContext.extensionUri,
				'assets',
				'prompts',
				'skills',
				SKILL_FOLDER_NAME,
				'SKILL.md',
			);

			const templateBytes = await vscode.workspace.fs.readFile(skillTemplateUri);
			const templateContent = new TextDecoder().decode(templateBytes);
			const runtimeContext = this.getRuntimeContext();
			const processedContent = templateContent.replace(RUNTIME_CONTEXT_PLACEHOLDER, runtimeContext);

			return new TextEncoder().encode(processedContent);
		} catch (error) {
			this.logService.error('[TroubleshootSkillProvider] Error reading skill template: ' + error);
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
