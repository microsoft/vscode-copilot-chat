/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { TRAJECTORY_FILE_EXTENSION, type IAgentTrajectory, type IObservationResult, type ITrajectoryStep } from '../../../platform/otel/common/atif/atifTypes';
import { convertConversationToAtif } from '../../../platform/otel/node/atif/otelToAtifConverter';
import { IOTelSqliteStore, type OTelSqliteStore } from '../../../platform/otel/node/sqlite/otelSqliteStore';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

const exportTrajectoriesCommand = 'github.copilot.chat.debug.exportTrajectories';

/**
 * Command contribution for exporting agent trajectories from the OTel SQLite store.
 * Replaces the legacy TrajectoryExportCommands that read from TrajectoryLogger.
 *
 * Same command IDs (backward compatible with eval harness).
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
		this._registerCommands();
	}

	private _registerCommands(): void {
		this._register(vscode.commands.registerCommand(exportTrajectoriesCommand, async (savePath?: string, options?: { agentOnly?: boolean }) => {
			await this._exportTrajectories(savePath, options);
		}));
	}

	private async _exportTrajectories(savePath?: string, options?: { agentOnly?: boolean }): Promise<void> {
		// Get all distinct conversation/trace IDs from the store
		const traceIds = this._sqliteStore.getTraceIds();
		if (traceIds.length === 0) {
			if (!savePath) {
				vscode.window.showInformationMessage('No trajectories found to export.');
			}
			return;
		}

		// Convert all traces to ATIF
		let mainTrajectory: IAgentTrajectory | undefined;
		const allSubagents = new Map<string, IAgentTrajectory>();

		for (const traceId of traceIds) {
			const { main, subagents } = convertConversationToAtif(this._sqliteStore, traceId);
			if (main && !mainTrajectory) {
				mainTrajectory = main;
			} else if (main) {
				allSubagents.set(main.session_id, main);
			}
			for (const [id, sub] of subagents) {
				allSubagents.set(id, sub);
			}
		}

		if (!mainTrajectory) {
			if (!savePath) {
				vscode.window.showInformationMessage('No agent trajectories found to export.');
			}
			return;
		}

		// Build trajectories map
		const trajectories = new Map<string, IAgentTrajectory>();
		trajectories.set(mainTrajectory.session_id, mainTrajectory);
		if (!options?.agentOnly) {
			for (const [id, sub] of allSubagents) {
				trajectories.set(id, sub);
			}
		} else {
			// agentOnly: include main + referenced subagents only
			const collected = this._collectTrajectoryWithSubagents(mainTrajectory, allSubagents);
			for (const [id, sub] of collected) {
				trajectories.set(id, sub);
			}
		}

		const saveDir = savePath
			? vscode.Uri.file(savePath)
			: await this._promptForFolder('Select Folder to Export Trajectories');

		if (!saveDir) {
			return;
		}

		try {
			const pathMapping = this._buildTrajectoryPathMapping(trajectories);
			await this._writeTrajectoriesToFolder(trajectories, saveDir, pathMapping);

			if (!savePath) {
				const revealAction = 'Reveal in Explorer';
				const result = await vscode.window.showInformationMessage(
					`Successfully exported ${trajectories.size} trajectories to ${saveDir.fsPath}`,
					revealAction
				);
				if (result === revealAction) {
					await vscode.commands.executeCommand('revealFileInOS', saveDir);
				}
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectories: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _buildTrajectoryPathMapping(trajectories: Map<string, IAgentTrajectory>): Map<string, string> {
		const mapping = new Map<string, string>();
		for (const trajectory of trajectories.values()) {
			const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
			for (const step of steps) {
				const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
				for (const r of results) {
					for (const ref of r.subagent_trajectory_ref ?? []) {
						if (ref.session_id && ref.trajectory_path && !mapping.has(ref.session_id)) {
							mapping.set(ref.session_id, ref.trajectory_path);
						}
					}
				}
			}
		}
		return mapping;
	}

	private _getTrajectoryFilename(sessionId: string, pathMapping: Map<string, string>): string {
		const referencedPath = pathMapping.get(sessionId);
		const rawFilename = referencedPath
			? this._sanitizeFilename(referencedPath)
			: this._sanitizeFilename(sessionId);
		return rawFilename.endsWith(TRAJECTORY_FILE_EXTENSION)
			? rawFilename
			: `${rawFilename}${TRAJECTORY_FILE_EXTENSION}`;
	}

	private async _writeTrajectoriesToFolder(
		trajectories: Map<string, IAgentTrajectory>,
		saveDir: vscode.Uri,
		pathMapping: Map<string, string>
	): Promise<void> {
		for (const [sessionId, trajectory] of trajectories) {
			const filename = this._getTrajectoryFilename(sessionId, pathMapping);
			const fileUri = vscode.Uri.joinPath(saveDir, filename);
			const content = JSON.stringify(trajectory, null, 2);
			await this._fsService.writeFile(fileUri, Buffer.from(content, 'utf8'));
		}
	}

	private async _promptForFolder(title: string): Promise<vscode.Uri | undefined> {
		const dialogResult = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title,
			defaultUri: vscode.Uri.file(os.homedir())
		});
		return dialogResult?.[0];
	}

	private _collectTrajectoryWithSubagents(
		mainTrajectory: IAgentTrajectory,
		allSubagents: Map<string, IAgentTrajectory>
	): Map<string, IAgentTrajectory> {
		const result = new Map<string, IAgentTrajectory>();
		const visited = new Set<string>();

		const collect = (trajectory: IAgentTrajectory) => {
			if (visited.has(trajectory.session_id)) { return; }
			visited.add(trajectory.session_id);
			result.set(trajectory.session_id, trajectory);

			const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
			for (const step of steps) {
				const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
				for (const r of results) {
					for (const ref of r.subagent_trajectory_ref ?? []) {
						const subTrajectory = allSubagents.get(ref.session_id);
						if (subTrajectory) {
							collect(subTrajectory);
						}
					}
				}
			}
		};

		collect(mainTrajectory);
		return result;
	}

	private _sanitizeFilename(name: string): string {
		return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
	}
}
