/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatDebugFileLoggerService } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { getCurrentCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { BaseSkillProvider } from './baseSkillProvider';

const RUNTIME_CONTEXT_PLACEHOLDER = '{{DEBUG_LOG_RUNTIME_CONTEXT}}';
const SESSION_LOG_PLACEHOLDER = '{{CURRENT_SESSION_LOG}}';

export class TroubleshootSkillProvider extends BaseSkillProvider {

	constructor(
		@ILogService logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IChatDebugFileLoggerService private readonly chatDebugFileLoggerService: IChatDebugFileLoggerService,
	) {
		super(logService, extensionContext, 'troubleshoot');
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

	protected override processTemplate(templateContent: string): string {
		const runtimeContext = this.getRuntimeContext();
		let processedContent = templateContent.replace(RUNTIME_CONTEXT_PLACEHOLDER, runtimeContext);

		// Resolve the session log path placeholder
		const sessionLogPath = this.resolveCurrentSessionLogPath();
		processedContent = processedContent.replace(SESSION_LOG_PLACEHOLDER, sessionLogPath ?? 'unavailable (no active session)');

		return processedContent;
	}

	private resolveCurrentSessionLogPath(): string | undefined {
		// Try the CapturingToken's chatSessionId first (available when called within captureInvocation)
		const chatSessionId = getCurrentCapturingToken()?.chatSessionId;
		if (chatSessionId) {
			const logPath = this.chatDebugFileLoggerService.getLogPath(chatSessionId);
			if (logPath) {
				return logPath.fsPath;
			}
		}

		// Fall back to the most recently created active session
		const activeIds = this.chatDebugFileLoggerService.getActiveSessionIds();
		if (activeIds.length > 0) {
			const lastId = activeIds[activeIds.length - 1];
			const logPath = this.chatDebugFileLoggerService.getLogPath(lastId);
			if (logPath) {
				return logPath.fsPath;
			}
		}

		return undefined;
	}
}
