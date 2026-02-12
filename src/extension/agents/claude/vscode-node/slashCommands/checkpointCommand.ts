/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { createDecorator, IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeAgentManager } from '../../node/claudeCodeAgent';
import { IClaudeSessionStateService } from '../../node/claudeSessionStateService';
import { IClaudeSlashCommandHandler, registerClaudeSlashCommand } from './claudeSlashCommandRegistry';

export const IClaudeCheckpointService = createDecorator<IClaudeCheckpointService>('claudeCheckpointService');

export interface IClaudeCheckpointService {
	readonly _serviceBrand: undefined;
	readonly agentManager: ClaudeAgentManager;
}

/**
 * Service to manage Claude Agent Manager instance for checkpoint operations.
 * This is needed because the ClaudeAgentManager is created in a different scope.
 */
export class ClaudeCheckpointService implements IClaudeCheckpointService {
	readonly _serviceBrand: undefined;

	constructor(
		public readonly agentManager: ClaudeAgentManager
	) { }
}

/**
 * Slash command handler for Claude checkpoint restoration.
 * Allows users to restore files to a previous state using Claude SDK's file checkpointing.
 */
export class CheckpointSlashCommand implements IClaudeSlashCommandHandler {
	readonly commandName = 'checkpoint';
	readonly description = 'Restore files to a previous checkpoint';
	readonly commandId = 'copilot.claude.checkpoint';

	constructor(
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) { }

	async handle(
		args: string,
		stream: vscode.ChatResponseStream | undefined,
		_token: CancellationToken
	): Promise<vscode.ChatResult> {
		// Get the current session ID from context
		// Note: This is a simplified implementation. In a real scenario, we'd need
		// to pass session context through the command system
		const sessionId = this._getCurrentSessionId();
		if (!sessionId) {
			stream?.markdown(vscode.l10n.t('⚠️ No active Claude session found. Start a conversation first.'));
			return {};
		}

		// Get the checkpoint service to access the agent manager
		const checkpointService = this.instantiationService.tryGetService(IClaudeCheckpointService);
		if (!checkpointService) {
			stream?.markdown(vscode.l10n.t('⚠️ Checkpoint service not available. Make sure Claude agent is enabled.'));
			return {};
		}

		const session = checkpointService.agentManager.getSession(sessionId);
		if (!session) {
			stream?.markdown(vscode.l10n.t('⚠️ Session not found: {0}', sessionId));
			return {};
		}

		const userMessageIds = session.getUserMessageIds();
		if (userMessageIds.length === 0) {
			stream?.markdown(vscode.l10n.t('ℹ️ No checkpoints available yet. Make some file changes first.'));
			return {};
		}

		// If args provided, try to use it as an index or UUID
		if (args.trim()) {
			const arg = args.trim();
			let targetMessageId: string | undefined;

			// Try as index first (e.g., "/checkpoint 1" for first checkpoint)
			const index = parseInt(arg, 10);
			if (!isNaN(index) && index > 0 && index <= userMessageIds.length) {
				targetMessageId = userMessageIds[index - 1];
			} else if (userMessageIds.includes(arg)) {
				// Try as UUID
				targetMessageId = arg;
			}

			if (targetMessageId) {
				return this._restoreCheckpoint(session, sessionId, targetMessageId, stream);
			} else {
				stream?.markdown(vscode.l10n.t('⚠️ Invalid checkpoint: {0}. Use a checkpoint number (1-{1}) or UUID.', arg, userMessageIds.length));
				return {};
			}
		}

		// No args - show picker
		return this._showCheckpointPicker(session, sessionId, userMessageIds, stream);
	}

	private _getCurrentSessionId(): string | undefined {
		// This is a placeholder. In a real implementation, we'd need to:
		// 1. Get the current chat widget context
		// 2. Extract the session ID from the widget
		// For now, we'll rely on the session state service to track active sessions
		// and use a heuristic to find the most recent one
		return undefined; // TODO: Implement proper session context tracking
	}

	private async _showCheckpointPicker(
		session: any,
		sessionId: string,
		userMessageIds: readonly string[],
		stream: vscode.ChatResponseStream | undefined
	): Promise<vscode.ChatResult> {
		stream?.markdown(vscode.l10n.t('Opening checkpoint picker...'));

		// Build QuickPick items
		const items: (vscode.QuickPickItem & { messageId: string; index: number })[] = userMessageIds.map((id, index) => ({
			label: `$(bookmark) Checkpoint ${index + 1}`,
			description: id,
			detail: vscode.l10n.t('Restore files to state at this point'),
			messageId: id,
			index: index + 1
		})).reverse(); // Show most recent first

		// Show QuickPick
		const selected = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Claude Checkpoints'),
			placeHolder: vscode.l10n.t('Select checkpoint to restore'),
			ignoreFocusOut: true,
		});

		if (selected) {
			return this._restoreCheckpoint(session, sessionId, selected.messageId, stream);
		}

		return {};
	}

	private async _restoreCheckpoint(
		session: any,
		sessionId: string,
		messageId: string,
		stream: vscode.ChatResponseStream | undefined
	): Promise<vscode.ChatResult> {
		try {
			// First, do a dry run to preview changes
			stream?.markdown(vscode.l10n.t('🔍 Previewing checkpoint restore...'));
			const dryRunResult = await session.rewindToCheckpoint(messageId, true);

			if (!dryRunResult.success) {
				stream?.markdown(vscode.l10n.t('❌ Cannot restore checkpoint: {0}', dryRunResult.error || 'Unknown error'));
				return {};
			}

			// Show preview and ask for confirmation
			const filesChanged = dryRunResult.filesChanged?.length || 0;
			const insertions = dryRunResult.insertions || 0;
			const deletions = dryRunResult.deletions || 0;

			stream?.markdown(
				vscode.l10n.t(
					'\n**Preview:**\n- Files to change: {0}\n- Lines to add: +{1}\n- Lines to remove: -{2}\n',
					filesChanged,
					insertions,
					deletions
				)
			);

			if (filesChanged === 0) {
				stream?.markdown(vscode.l10n.t('ℹ️ No changes needed - files already at checkpoint state.'));
				return {};
			}

			// Ask for confirmation
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t(
					'Restore checkpoint? This will modify {0} file(s) with +{1}/-{2} lines.',
					filesChanged,
					insertions,
					deletions
				),
				{ modal: true },
				vscode.l10n.t('Restore')
			);

			if (confirm) {
				stream?.markdown(vscode.l10n.t('\n⏳ Restoring checkpoint...'));
				const result = await session.rewindToCheckpoint(messageId, false);

				if (result.success) {
					stream?.markdown(
						vscode.l10n.t(
							'\n✅ **Checkpoint restored successfully!**\n\nModified {0} file(s):\n',
							result.filesChanged?.length || 0
						)
					);

					if (result.filesChanged && result.filesChanged.length > 0) {
						for (const file of result.filesChanged.slice(0, 10)) {
							stream?.markdown(`- \`${file}\`\n`);
						}
						if (result.filesChanged.length > 10) {
							stream?.markdown(vscode.l10n.t('...and {0} more files\n', result.filesChanged.length - 10));
						}
					}
				} else {
					stream?.markdown(vscode.l10n.t('\n❌ Failed to restore checkpoint: {0}', result.error || 'Unknown error'));
				}
			} else {
				stream?.markdown(vscode.l10n.t('\n🚫 Checkpoint restore cancelled.'));
			}

			return {};
		} catch (error) {
			this.logService.error('[CheckpointSlashCommand] Error restoring checkpoint:', error);
			stream?.markdown(vscode.l10n.t('\n❌ Error: {0}', error instanceof Error ? error.message : String(error)));
			return {};
		}
	}
}

// Self-register the checkpoint command
registerClaudeSlashCommand(CheckpointSlashCommand);
