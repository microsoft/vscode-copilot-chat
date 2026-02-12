/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { createDecorator, IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeAgentManager, ClaudeCodeSession } from '../../node/claudeCodeAgent';
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
 * 
 * Note: This implementation currently has a limitation where it cannot access the current
 * session context from the slash command system. A proper implementation would require
 * passing session context through the command invocation.
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
		stream?.markdown(vscode.l10n.t('⚠️ **Checkpoint feature is currently under development.**\n\n'));
		stream?.markdown(vscode.l10n.t('The `/checkpoint` command requires session context which is not yet available in the slash command system.\n\n'));
		stream?.markdown(vscode.l10n.t('**To track progress**: This PR enables file checkpointing in the Claude SDK and provides the API methods needed for checkpoint restoration. Future work will integrate this with the chat UI to make it user-accessible.\n\n'));
		stream?.markdown(vscode.l10n.t('**Technical details**: See `CHECKPOINT.md` for implementation documentation.'));

		return {};
	}

	// TODO: Implement session context tracking to enable this feature
	// The following methods show the intended implementation pattern:
	
	/* Example implementation (currently non-functional due to session context limitation):
	
	private async _showCheckpointPicker(
		session: ClaudeCodeSession,
		userMessageIds: readonly string[],
		stream: vscode.ChatResponseStream | undefined
	): Promise<vscode.ChatResult> {
		// Build QuickPick items
		const items: (vscode.QuickPickItem & { messageId: string; index: number })[] = userMessageIds.map((id, index) => ({
			label: `$(bookmark) Checkpoint ${index + 1}`,
			description: id,
			detail: vscode.l10n.t('Restore files to state at this point'),
			messageId: id,
			index: index + 1
		})).reverse();

		const selected = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Claude Checkpoints'),
			placeHolder: vscode.l10n.t('Select checkpoint to restore'),
			ignoreFocusOut: true,
		});

		if (selected) {
			return this._restoreCheckpoint(session, selected.messageId, stream);
		}

		return {};
	}

	private async _restoreCheckpoint(
		session: ClaudeCodeSession,
		messageId: string,
		stream: vscode.ChatResponseStream | undefined
	): Promise<vscode.ChatResult> {
		// Preview changes
		const dryRunResult = await session.rewindToCheckpoint(messageId, true);
		
		if (!dryRunResult.success) {
			stream?.markdown(vscode.l10n.t('❌ Cannot restore checkpoint: {0}', dryRunResult.error || 'Unknown error'));
			return {};
		}

		// Show preview and confirm
		const filesChanged = dryRunResult.filesChanged?.length || 0;
		if (filesChanged === 0) {
			stream?.markdown(vscode.l10n.t('ℹ️ No changes needed - files already at checkpoint state.'));
			return {};
		}

		const confirm = await vscode.window.showWarningMessage(
			vscode.l10n.t('Restore checkpoint? This will modify {0} file(s).', filesChanged),
			{ modal: true },
			vscode.l10n.t('Restore')
		);

		if (confirm) {
			const result = await session.rewindToCheckpoint(messageId, false);
			if (result.success) {
				stream?.markdown(vscode.l10n.t('✅ Checkpoint restored successfully!'));
			} else {
				stream?.markdown(vscode.l10n.t('❌ Failed to restore: {0}', result.error));
			}
		}

		return {};
	}
	*/
}

// Self-register the checkpoint command
registerClaudeSlashCommand(CheckpointSlashCommand);
