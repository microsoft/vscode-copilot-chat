/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatDebugFileLoggerService } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IExtensionContribution } from '../../common/contributions';

const BULK_METADATA_FILENAME = 'copilotcli.session.metadata.json';

export const troubleshootPickSessionCommand = 'github.copilot.troubleshoot.pickSession';

export class TroubleshootSessionPickerContribution extends Disposable implements IExtensionContribution {
	readonly id = 'troubleshootSessionPicker';

	private _cachedMetadata: Record<string, { customTitle?: string; firstUserMessage?: string }> | undefined;

	/**
	 * The session ID of the caller that last triggered openTroubleshootChat.
	 * Used to distinguish "the caller invoking /troubleshoot again" from
	 * "the newly-opened troubleshoot chat auto-submitting /troubleshoot".
	 */
	private _pendingCallerSessionId: string | undefined;

	constructor(
		@IChatDebugFileLoggerService private readonly chatDebugFileLoggerService: IChatDebugFileLoggerService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(vscode.commands.registerCommand(troubleshootPickSessionCommand, (args?: { question?: string; sessionId?: string; skipPicker?: boolean }) => this.pickSession(args?.question, args?.sessionId, args?.skipPicker)));
	}

	/**
	 * Entry point for the troubleshoot session picker command.
	 *
	 * `sessionId` is always the **caller** — the session where the user typed
	 * `/troubleshoot` or right-clicked "Troubleshoot in New Chat".
	 *
	 * Returns `true` if this method handled the request (caller should stop),
	 * or `false` if the calling session is itself a troubleshoot session
	 * (caller should let the skill handle /troubleshoot directly).
	 *
	 * Behaviour:
	 * - Troubleshoot session calls → return false (skill handles it)
	 * - question or skipPicker with sessionId → open directly, no picker
	 * - bare /troubleshoot → show picker
	 */
	private async pickSession(question?: string, sessionId?: string, skipPicker?: boolean): Promise<boolean> {
		// ── 1. Already in a troubleshoot session? ──
		// If the caller has a registered troubleshoot target, it IS a
		// troubleshoot session — return false so the skill handles it.
		if (sessionId && this.chatDebugFileLoggerService.getTroubleshootTarget(sessionId)) {
			return false;
		}

		// ── 2. Newly-opened troubleshoot chat (pre-skill consumption)? ──
		// After openTroubleshootChat sets a pending target, the new chat
		// auto-submits /troubleshoot which arrives here. We detect it
		// because the caller is NOT the session that initiated the open.
		if (this.chatDebugFileLoggerService.hasPendingTroubleshootTarget()
			&& sessionId !== this._pendingCallerSessionId) {
			return false;
		}

		// ── 3. Normal flow from a non-troubleshoot session ──
		const sessions = await this.chatDebugFileLoggerService.listSessionDirsOnDisk();
		if (sessions.length === 0) {
			vscode.window.showInformationMessage('No debug log sessions found on disk.');
			return true;
		}

		// Skip the picker and open troubleshoot chat directly when:
		// - "/troubleshoot <question>" — current session implied
		// - "Troubleshoot in New Chat" context menu (skipPicker)
		if (sessionId && (question || skipPicker) && sessions.some(s => s.sessionId === sessionId)) {
			return this.openTroubleshootChat(sessionId, await this.resolveTitle(sessionId), question, sessionId);
		}

		// ── 4. Show picker ──
		const items = await this.resolveQuickPickItems(sessions);

		// Pin the current session to the top if it has debug logs
		if (sessionId && sessions.some(s => s.sessionId === sessionId)) {
			const idx = items.findIndex(i => i.sessionId === sessionId);
			const currentItem = idx >= 0 ? items.splice(idx, 1)[0] : undefined;
			items.unshift({
				label: `$(sparkle) Current session${currentItem ? ': ' + currentItem.label : ''}`,
				description: 'Troubleshoot this session',
				sessionId,
			});
		}

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a session to troubleshoot',
			matchOnDescription: true,
		});

		if (!picked) {
			return true;
		}

		const sessionLabel = picked.label.replace(/\$\([^)]+\)\s*/g, '');
		return this.openTroubleshootChat(picked.sessionId, sessionLabel, question, sessionId);
	}

	/**
	 * Open a new troubleshoot chat editor targeting the given session.
	 *
	 * @param targetSessionId - The session whose logs will be analysed.
	 * @param sessionLabel    - Human-readable label for the target session.
	 * @param question        - Optional question to auto-submit.
	 * @param callerSessionId - The session that initiated this call (used
	 *                          for pending-target gating in {@link pickSession}).
	 */
	private async openTroubleshootChat(targetSessionId: string, sessionLabel: string, question?: string, callerSessionId?: string): Promise<boolean> {
		const debugLogsDir = this.chatDebugFileLoggerService.debugLogsDir;
		if (!debugLogsDir) {
			this.logService.error('[TroubleshootSessionPicker] No debug logs directory available');
			return true;
		}

		const targetLogDir = URI.joinPath(debugLogsDir, targetSessionId);
		this._pendingCallerSessionId = callerSessionId;
		this.chatDebugFileLoggerService.setPendingTroubleshootTarget(targetLogDir);

		const query = question
			? `/troubleshoot ${question}`
			: '/troubleshoot Analyze this session for any issues.';

		// Open a new chat editor in the main editor area (full editor space,
		// docked like a regular file tab). Seed it with context about which
		// session is being troubleshot, then pre-fill or auto-submit the query.
		await vscode.commands.executeCommand('workbench.action.openChat');
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			previousRequests: [{
				request: `[Troubleshooting session: "${sessionLabel}" (${targetSessionId})]`,
				response: `Ready to troubleshoot session **"${sessionLabel}"**.\n\nSession logs directory: \`${targetLogDir.fsPath}\`\n\nAsk any questions directly.`,
			}],
			query,
			isPartialQuery: !question,
		});
		return true;
	}

	private async resolveQuickPickItems(
		sessions: readonly { sessionId: string; mtime: number }[],
	): Promise<(vscode.QuickPickItem & { sessionId: string })[]> {
		const results = await Promise.allSettled(
			sessions.map(async s => {
				const title = await this.resolveTitle(s.sessionId);
				return { sessionId: s.sessionId, title, mtime: s.mtime };
			}),
		);

		return results
			.filter((r): r is PromiseFulfilledResult<{ sessionId: string; title: string; mtime: number }> => r.status === 'fulfilled')
			.map(r => {
				const time = formatRelativeTime(r.value.mtime);
				const isIdOnly = r.value.title === (r.value.sessionId.length > 8 ? r.value.sessionId.slice(0, 8) + '...' : r.value.sessionId);
				return {
					label: isIdOnly ? `$(clock) ${r.value.title}  ${time}` : r.value.title,
					description: isIdOnly ? r.value.sessionId : time,
					sessionId: r.value.sessionId,
				};
			});
	}

	private async resolveTitle(sessionId: string): Promise<string> {
		const debugLogsDir = this.chatDebugFileLoggerService.debugLogsDir;
		if (!debugLogsDir) {
			return sessionId.length > 8 ? sessionId.slice(0, 8) + '...' : sessionId;
		}

		const sessionDir = URI.joinPath(debugLogsDir, sessionId);

		// 1. Try the title-*.jsonl child file (~500 bytes, very cheap)
		try {
			const files = await this.fileSystemService.readDirectory(sessionDir);
			const titleFile = files.find(([name]) => name.startsWith('title-'));
			if (titleFile) {
				const titleUri = URI.joinPath(sessionDir, titleFile[0]);
				const content = new TextDecoder().decode(await this.fileSystemService.readFile(titleUri));
				for (const line of content.split('\n')) {
					if (!line.trim()) {
						continue;
					}
					try {
						const entry = JSON.parse(line);
						if (entry.type === 'agent_response' && entry.attrs?.response) {
							const parts = JSON.parse(entry.attrs.response);
							const title = parts[0]?.parts?.[0]?.content;
							if (title) {
								return String(title).length > 80 ? String(title).slice(0, 77) + '...' : String(title);
							}
						}
					} catch {
						// skip
					}
				}
			}
		} catch {
			// ignore
		}

		// 2. Fall back to bulk metadata (for CLI agent sessions)
		const metadata = await this.loadMetadata();
		const metaEntry = metadata[sessionId];
		if (metaEntry?.customTitle) {
			const title = metaEntry.customTitle;
			return title.length > 80 ? title.slice(0, 77) + '...' : title;
		}
		if (metaEntry?.firstUserMessage) {
			const msg = metaEntry.firstUserMessage;
			return msg.length > 80 ? msg.slice(0, 77) + '...' : msg;
		}

		// 3. Fall back to session ID prefix
		return sessionId.length > 8 ? sessionId.slice(0, 8) + '...' : sessionId;
	}

	private async loadMetadata(): Promise<Record<string, { customTitle?: string; firstUserMessage?: string }>> {
		if (this._cachedMetadata) {
			return this._cachedMetadata;
		}
		try {
			const metadataUri = URI.joinPath(this.extensionContext.globalStorageUri, 'copilotcli', BULK_METADATA_FILENAME);
			const raw = new TextDecoder().decode(await this.fileSystemService.readFile(metadataUri));
			this._cachedMetadata = JSON.parse(raw);
			return this._cachedMetadata!;
		} catch {
			return {};
		}
	}
}

function formatRelativeTime(epochMs: number): string {
	if (!epochMs) {
		return '';
	}
	const diffMs = Date.now() - epochMs;
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
