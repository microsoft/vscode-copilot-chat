/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import {
	TRAJECTORY_FILE_EXTENSION,
	type IAgentTrajectory,
	type IObservationResult,
	type ITrajectoryStep,
} from '../../../platform/otel/common/atif/atifTypes';
import { convertTraceToAtif } from '../../../platform/otel/node/atif/otelToAtifConverter';
import { IOTelSqliteStore, type OTelSqliteStore } from '../../../platform/otel/node/sqlite/otelSqliteStore';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

const exportCommand = 'github.copilot.chat.debug.exportATIFTrajectories';

/**
 * Decode a VS Code chat session resource URI to extract the raw session ID.
 * Same logic as the debug panel (otelChatDebugLogProvider.ts decodeSessionId).
 */
function decodeSessionResource(sessionResource: vscode.Uri): string {
	if (sessionResource.scheme === 'copilotcli' || sessionResource.scheme === 'claude-code') {
		return sessionResource.path.replace(/^\//, '');
	}
	const pathSegment = sessionResource.path.replace(/^\//, '').split('/').pop() || '';
	if (pathSegment) {
		try {
			return Buffer.from(pathSegment, 'base64').toString('utf-8');
		} catch { /* not base64, use as-is */ }
	}
	return sessionResource.toString();
}

/**
 * Export agent trajectories in ATIF format from the OTel SQLite store.
 *
 * Behavior:
 * - **Programmatic** (eval harness): called with `saveDir` URI → exports the most recent
 *   (active) session's trajectory + subagents to that folder.
 * - **Interactive** (command palette): exports the most recent session, prompts for folder.
 *
 * File naming:
 * - Main trajectory: `trajectory.json`
 * - Subagent trajectories: `<sanitized-session-id>.trajectory.json`
 *   (or the path from subagent_trajectory_ref if available)
 */
export class AtifExportCommands extends Disposable implements IExtensionContribution {
	readonly id = 'atifExportCommands';

	private readonly _sqliteStore: OTelSqliteStore;
	private readonly _fsService: IFileSystemService;

	constructor(
		@IOTelSqliteStore sqliteStore: OTelSqliteStore,
		@IFileSystemService fileSystemService: IFileSystemService,
	) {
		super();
		this._sqliteStore = sqliteStore;
		this._fsService = fileSystemService;
		this._register(vscode.commands.registerCommand(exportCommand, async (saveDir?: vscode.Uri | string) => {
			await this._export(typeof saveDir === 'string' ? vscode.Uri.file(saveDir) : saveDir);
		}));
	}

	private async _export(saveDir?: vscode.Uri): Promise<void> {
		// Get the active chat session from VS Code — same URI the debug panel uses.
		// Uses proposed API chatParticipantPrivate.activeChatPanelSessionResource.
		const sessionResource = (vscode.chat as { activeChatPanelSessionResource?: vscode.Uri })?.activeChatPanelSessionResource;
		if (!sessionResource) {
			if (!saveDir) {
				vscode.window.showInformationMessage('No active chat session. Open a chat session first.');
			}
			return;
		}

		// Decode session ID from the URI (same logic as debug panel)
		const sessionId = decodeSessionResource(sessionResource);

		// Get traces for this session
		const traceIds = this._sqliteStore.getTraceIds(sessionId);
		if (traceIds.length === 0) {
			return;
		}

		// Convert traces to ATIF
		let mainTrajectory: IAgentTrajectory | undefined;
		const subagents = new Map<string, IAgentTrajectory>();

		for (const traceId of traceIds) {
			const result = convertTraceToAtif(this._sqliteStore, traceId);
			if (result.main && !mainTrajectory) {
				mainTrajectory = result.main;
			} else if (result.main) {
				subagents.set(result.main.session_id, result.main);
			}
			for (const [id, sub] of result.subagents) {
				subagents.set(id, sub);
			}
		}

		if (!mainTrajectory) {
			if (!saveDir) {
				vscode.window.showInformationMessage('No agent trajectories found to export.');
			}
			return;
		}

		// Prompt for folder if not provided
		if (!saveDir) {
			const dialogResult = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				title: 'Export Agent Trajectory (ATIF)',
				defaultUri: vscode.Uri.file(os.homedir()),
			});
			saveDir = dialogResult?.[0];
			if (!saveDir) {
				return;
			}
		}

		// Collect referenced subagent paths for filename resolution
		const refPaths = this._collectSubagentPaths(mainTrajectory);

		try {
			// Write main trajectory as trajectory.json
			await this._writeTrajectory(saveDir, 'trajectory.json', mainTrajectory);

			// Write subagent trajectories
			for (const [sessionId, sub] of subagents) {
				const filename = refPaths.get(sessionId)
					?? `${this._sanitize(sessionId)}${TRAJECTORY_FILE_EXTENSION}`;
				await this._writeTrajectory(saveDir, filename, sub);
			}

			if (!saveDir) {
				return;
			}

			const totalFiles = 1 + subagents.size;
			const subMsg = subagents.size > 0
				? ` (+ ${subagents.size} subagent ${subagents.size === 1 ? 'trajectory' : 'trajectories'})`
				: '';

			const revealAction = 'Reveal in Explorer';
			const result = await vscode.window.showInformationMessage(
				`Exported ${totalFiles} ATIF trajectory file${totalFiles > 1 ? 's' : ''}${subMsg} to ${saveDir.fsPath}`,
				revealAction,
			);
			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveDir);
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to export trajectories: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async _writeTrajectory(dir: vscode.Uri, filename: string, trajectory: IAgentTrajectory): Promise<void> {
		const fileUri = vscode.Uri.joinPath(dir, filename);
		const content = JSON.stringify(trajectory, null, 2);
		await this._fsService.writeFile(fileUri, Buffer.from(content, 'utf8'));
	}

	/** Collect subagent_trajectory_ref paths from a trajectory for filename resolution. */
	private _collectSubagentPaths(trajectory: IAgentTrajectory): Map<string, string> {
		const paths = new Map<string, string>();
		const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
		for (const step of steps) {
			const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
			for (const r of results) {
				for (const ref of r.subagent_trajectory_ref ?? []) {
					if (ref.session_id && ref.trajectory_path) {
						paths.set(ref.session_id, ref.trajectory_path);
					}
				}
			}
		}
		return paths;
	}

	private _sanitize(name: string): string {
		return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 100);
	}
}
