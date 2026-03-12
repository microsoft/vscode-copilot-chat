/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

	private getRuntimeContext(): string {
		const lines: string[] = [];
		lines.push('## Runtime Log Context');
		lines.push('');

		// Provide the debug-logs directory path so the agent can find log files
		const storageUri = this.extensionContext.storageUri;
		if (storageUri) {
			lines.push('- Current session log directory: `{{CURRENT_SESSION_LOG}}`');
		} else {
			lines.push('- Debug-logs directory: unavailable in this environment. Abort now and tell the user that troubleshooting is only available if a workspace is open.');
		}

		return lines.join('\n');
	}

	protected override processTemplate(templateContent: string): string {
		const runtimeContext = this.getRuntimeContext();
		let processedContent = templateContent.replace(RUNTIME_CONTEXT_PLACEHOLDER, runtimeContext);

		// Resolve the session log directory placeholder
		const sessionLogDir = this.resolveCurrentSessionLogDir();
		processedContent = processedContent.replace(SESSION_LOG_PLACEHOLDER, sessionLogDir ?? 'unavailable (no active session)');

		return processedContent;
	}

	private resolveCurrentSessionLogDir(): string | undefined {
		// Try the CapturingToken's chatSessionId first (available when called within captureInvocation)
		const chatSessionId = getCurrentCapturingToken()?.chatSessionId;
		if (chatSessionId) {
			const dir = this.chatDebugFileLoggerService.getSessionDir(chatSessionId);
			if (dir) {
				return dir.toString();
			}
		}

		// Fall back to the most recently created active session
		const activeIds = this.chatDebugFileLoggerService.getActiveSessionIds();
		if (activeIds.length > 0) {
			const lastId = activeIds[activeIds.length - 1];
			const dir = this.chatDebugFileLoggerService.getSessionDir(lastId);
			if (dir) {
				return dir.toString();
			}
		}

		return undefined;
	}
}
