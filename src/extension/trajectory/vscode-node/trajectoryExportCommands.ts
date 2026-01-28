/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { TRAJECTORY_FILE_EXTENSION, type IAgentTrajectory, type IObservationResult, type ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { TrajectoryLoggerAdapter } from '../../../platform/trajectory/node/trajectoryLoggerAdapter';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { renderToolResultToStringNoBudget } from '../../prompt/vscode-node/requestLoggerToolResult';

const exportTrajectoriesCommand = 'github.copilot.chat.debug.exportTrajectories';
const exportSingleTrajectoryCommand = 'github.copilot.chat.debug.exportSingleTrajectory';

/**
 * Command contribution for exporting agent trajectories
 */
export class TrajectoryExportCommands extends Disposable implements IExtensionContribution {
	readonly id = 'trajectoryExportCommands';
	private readonly adapter: TrajectoryLoggerAdapter;

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
		@IRequestLogger requestLogger: IRequestLogger,
		@IInstantiationService _instantiationService: IInstantiationService
	) {
		super();
		// Initialize adapter to bridge RequestLogger to TrajectoryLogger
		// The adapter subscribes to RequestLogger events and populates TrajectoryLogger
		this.adapter = this._register(new TrajectoryLoggerAdapter(requestLogger, trajectoryLogger, renderToolResultToStringNoBudget));
		this.registerCommands();
	}

	private registerCommands(): void {
		this._register(vscode.commands.registerCommand(exportTrajectoriesCommand, async (savePath?: string) => {
			await this.exportTrajectories(savePath);
		}));

		this._register(vscode.commands.registerCommand(exportSingleTrajectoryCommand, async (treeItem?: { token?: CapturingToken }) => {
			await this.exportSingleTrajectory(treeItem);
		}));
	}

	private async exportTrajectories(savePath?: string): Promise<void> {
		const trajectories = this.trajectoryLogger.getAllTrajectories();

		if (trajectories.size === 0) {
			vscode.window.showInformationMessage('No trajectories found to export.');
			return;
		}

		// Always export as separate files (one per trajectory)
		await this.exportMultipleTrajectories(trajectories, savePath);
	}

	/**
	 * Export a single trajectory and its referenced subagent trajectories
	 * @param treeItem The tree item containing the capturing token
	 */
	private async exportSingleTrajectory(treeItem?: { token?: CapturingToken }): Promise<void> {
		if (!treeItem?.token) {
			vscode.window.showWarningMessage('No trajectory available for this item.');
			return;
		}

		const sessionId = this.adapter.getSessionIdForToken(treeItem.token);
		if (!sessionId) {
			vscode.window.showWarningMessage('No trajectory found for this request. Try running the request first.');
			return;
		}

		const allTrajectories = this.trajectoryLogger.getAllTrajectories();
		const mainTrajectory = allTrajectories.get(sessionId);

		if (!mainTrajectory) {
			vscode.window.showWarningMessage('Trajectory data not found.');
			return;
		}

		// Collect the main trajectory and all referenced subagent trajectories
		const trajectoriesToExport = this.collectTrajectoryWithSubagents(mainTrajectory, allTrajectories);

		if (trajectoriesToExport.size === 0) {
			vscode.window.showWarningMessage('No trajectory data to export.');
			return;
		}

		// Show save dialog
		const dialogResult = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Select folder to export trajectory',
			defaultUri: vscode.Uri.file(os.homedir())
		});

		if (!dialogResult || dialogResult.length === 0) {
			return; // User cancelled
		}

		const saveDir = dialogResult[0];

		try {
			// Build sessionId -> trajectory_path mapping from subagent refs
			const sessionIdToTrajectoryPath = new Map<string, string>();
			for (const trajectory of trajectoriesToExport.values()) {
				const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
				for (const step of steps) {
					const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
					for (const r of results) {
						for (const ref of r.subagent_trajectory_ref ?? []) {
							if (ref.session_id && ref.trajectory_path && !sessionIdToTrajectoryPath.has(ref.session_id)) {
								sessionIdToTrajectoryPath.set(ref.session_id, ref.trajectory_path);
							}
						}
					}
				}
			}

			let successCount = 0;

			for (const [trajSessionId, trajectory] of trajectoriesToExport) {
				const referencedPath = sessionIdToTrajectoryPath.get(trajSessionId);
				const filename = referencedPath
					? this.sanitizeFilename(referencedPath)
					: `${this.sanitizeFilename(trajSessionId)}${TRAJECTORY_FILE_EXTENSION}`;
				const fileUri = vscode.Uri.joinPath(saveDir, filename);

				const content = JSON.stringify(trajectory, null, 2);
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
				successCount++;
			}

			const subagentCount = trajectoriesToExport.size - 1;
			const subagentMsg = subagentCount > 0 ? ` (including ${subagentCount} subagent ${subagentCount === 1 ? 'trajectory' : 'trajectories'})` : '';

			const revealAction = 'Reveal in Explorer';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported trajectory${subagentMsg} to ${saveDir.fsPath}`,
				revealAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveDir);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectory: ${error}`);
		}
	}

	/**
	 * Recursively collect a trajectory and all its referenced subagent trajectories
	 */
	private collectTrajectoryWithSubagents(
		mainTrajectory: IAgentTrajectory,
		allTrajectories: Map<string, IAgentTrajectory>
	): Map<string, IAgentTrajectory> {
		const result = new Map<string, IAgentTrajectory>();
		const visited = new Set<string>();

		const collect = (trajectory: IAgentTrajectory) => {
			if (visited.has(trajectory.session_id)) {
				return;
			}
			visited.add(trajectory.session_id);
			result.set(trajectory.session_id, trajectory);

			// Find subagent references in this trajectory's steps
			const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
			for (const step of steps) {
				const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
				for (const r of results) {
					for (const ref of r.subagent_trajectory_ref ?? []) {
						const subagentTrajectory = allTrajectories.get(ref.session_id);
						if (subagentTrajectory) {
							collect(subagentTrajectory);
						}
					}
				}
			}
		};

		collect(mainTrajectory);
		return result;
	}

	private async exportMultipleTrajectories(
		trajectories: Map<string, IAgentTrajectory>,
		savePath?: string
	): Promise<void> {
		let saveDir: vscode.Uri;

		if (savePath && typeof savePath === 'string') {
			saveDir = vscode.Uri.file(savePath);
		} else {
			const dialogResult = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				title: 'Select folder to export trajectories',
				defaultUri: vscode.Uri.file(os.homedir())
			});

			if (!dialogResult || dialogResult.length === 0) {
				return; // User cancelled
			}
			saveDir = dialogResult[0];
		}

		try {
			const sessionIdToTrajectoryPath = new Map<string, string>();
			for (const trajectory of trajectories.values()) {
				const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
				for (const step of steps) {
					const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
					for (const r of results) {
						for (const ref of r.subagent_trajectory_ref ?? []) {
							if (ref.session_id && ref.trajectory_path && !sessionIdToTrajectoryPath.has(ref.session_id)) {
								sessionIdToTrajectoryPath.set(ref.session_id, ref.trajectory_path);
							}
						}
					}
				}
			}

			let successCount = 0;

			for (const [sessionId, trajectory] of trajectories) {
				const referencedPath = sessionIdToTrajectoryPath.get(sessionId);
				const filename = referencedPath
					? this.sanitizeFilename(referencedPath)
					: `${this.sanitizeFilename(sessionId)}${TRAJECTORY_FILE_EXTENSION}`;
				const fileUri = vscode.Uri.joinPath(saveDir, filename);

				const content = JSON.stringify(trajectory, null, 2);
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
				successCount++;
			}

			const revealAction = 'Reveal in Explorer';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported ${successCount} trajectories to ${saveDir.fsPath}`,
				revealAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveDir);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectories: ${error}`);
		}
	}

	private sanitizeFilename(name: string): string {
		// Remove invalid filename characters
		return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
	}
}
