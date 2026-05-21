/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatDebugFileLoggerService } from '../../../../../platform/chat/common/chatDebugFileLoggerService';
import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IClaudeSlashCommandHandler, registerClaudeSlashCommand } from './claudeSlashCommandRegistry';

const RUNTIME_CONTEXT_PLACEHOLDER = '{{DEBUG_LOG_RUNTIME_CONTEXT}}';

/**
 * Slash command handler for /troubleshoot in Claude sessions.
 *
 * Loads the troubleshoot SKILL.md template, resolves the debug log path placeholders,
 * and returns a rewritten prompt that includes the skill instructions so Claude can
 * investigate the session's debug logs.
 */
export class TroubleshootSlashCommand implements IClaudeSlashCommandHandler {
	readonly commandName = 'troubleshoot';
	readonly description = 'Investigate unexpected chat behavior using debug logs';

	/** Cached skill template (without runtime context — that's resolved per-invocation) */
	private _cachedTemplate: string | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IChatDebugFileLoggerService private readonly debugFileLogger: IChatDebugFileLoggerService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) { }

	async handle(
		args: string,
		_stream: vscode.ChatResponseStream | undefined,
		_token: CancellationToken,
		context?: { readonly sessionId?: string },
	): Promise<{ rewrittenPrompt: string }> {
		const skillContent = await this._loadSkillContent(context?.sessionId);
		const userQuestion = args.trim() || 'What went wrong in this session?';
		return { rewrittenPrompt: `${skillContent}\n\n---\n\nUser question: ${userQuestion}` };
	}

	private async _loadSkillContent(sessionId: string | undefined): Promise<string> {
		const template = await this._loadTemplate();
		return template.replace(RUNTIME_CONTEXT_PLACEHOLDER, this._getRuntimeContext(sessionId));
	}

	private async _loadTemplate(): Promise<string> {
		if (this._cachedTemplate) {
			return this._cachedTemplate;
		}
		try {
			const skillUri = URI.joinPath(
				this.extensionContext.extensionUri,
				'assets', 'prompts', 'skills', 'troubleshoot', 'SKILL.md'
			);
			const bytes = await vscode.workspace.fs.readFile(skillUri);
			let content = new TextDecoder().decode(bytes);

			// Strip YAML frontmatter
			if (content.startsWith('---')) {
				const endIdx = content.indexOf('\n---', 3);
				if (endIdx !== -1) {
					content = content.substring(endIdx + 4).trimStart();
				}
			}

			this._cachedTemplate = content;
			return content;
		} catch (error) {
			this.logService.error('[TroubleshootSlashCommand] Failed to load SKILL.md:', error);
			return 'Troubleshoot skill unavailable. Investigate the debug logs manually.';
		}
	}

	private _getRuntimeContext(sessionId: string | undefined): string {
		const logDir = this.debugFileLogger.debugLogsDir;
		if (!logDir) {
			return '## Runtime Log Context\n\n- Debug-logs directory: unavailable in this environment. Abort now and tell the user that troubleshooting is only available if a workspace is open.';
		}

		if (sessionId) {
			const sessionLogPath = URI.joinPath(logDir, sessionId).fsPath;
			return `## Runtime Log Context\n\n- Current session log directory: \`${sessionLogPath}\``;
		}

		return `## Runtime Log Context\n\n- Debug-logs directory: \`${logDir.fsPath}\`\n- No active session detected. List session directories to find the relevant logs.`;
	}
}
registerClaudeSlashCommand(TroubleshootSlashCommand);
