/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatDebugFileLoggerService } from '../../../platform/chat/common/chatDebugFileLoggerService';
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
		@IChatDebugFileLoggerService private readonly chatDebugFileLoggerService: IChatDebugFileLoggerService,
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
		const activeSessionIds = this.chatDebugFileLoggerService.getActiveSessionIds();

		const lines: string[] = [];
		lines.push('## Runtime Log Context');
		lines.push('');
		if (workspaceHash) {
			lines.push('- Workspace hash: `' + workspaceHash + '`');
		} else {
			lines.push('- Workspace hash: unavailable in this environment');
		}
		lines.push('- Expected debug-log layout: `User/workspaceStorage/{workspaceHash}/GitHub.copilot-chat/debug-logs/{sessionId}.jsonl`');
		if (activeSessionIds.length === 0) {
			lines.push('- Active debug-log sessions: none currently; locate recent `.jsonl` files in `debug-logs` and infer session from timeline.');
		} else {
			lines.push('- Active debug-log sessions:');
			for (const sessionId of activeSessionIds) {
				const logPath = this.chatDebugFileLoggerService.getLogPath(sessionId);
				if (logPath) {
					lines.push('  - session `' + sessionId + '`: `' + logPath.fsPath + '`');
				} else {
					lines.push('  - session `' + sessionId + '`: path unavailable');
				}
			}
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
