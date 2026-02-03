/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { TRAJECTORY_FILE_EXTENSION, type IAgentTrajectory, type IObservationResult, type ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { TrajectoryLoggerAdapter } from '../../../platform/trajectory/node/trajectoryLoggerAdapter';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
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
		@IConfigurationService configService: IConfigurationService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		super();
		// Initialize adapter to bridge RequestLogger to TrajectoryLogger
		// The adapter subscribes to RequestLogger events and populates TrajectoryLogger
		this.adapter = this._register(new TrajectoryLoggerAdapter(requestLogger, trajectoryLogger, configService, renderToolResultToStringNoBudget));
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

	/**
	 * Build a mapping from sessionId to trajectory_path by scanning subagent refs
	 */
	private buildTrajectoryPathMapping(trajectories: Map<string, IAgentTrajectory>): Map<string, string> {
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

	/**
	 * Get the filename for a trajectory, using referenced path if available
	 */
	private getTrajectoryFilename(sessionId: string, pathMapping: Map<string, string>): string {
		const referencedPath = pathMapping.get(sessionId);
		const rawFilename = referencedPath
			? this.sanitizeFilename(referencedPath)
			: this.sanitizeFilename(sessionId);
		return rawFilename.endsWith(TRAJECTORY_FILE_EXTENSION)
			? rawFilename
			: `${rawFilename}${TRAJECTORY_FILE_EXTENSION}`;
	}

	/**
	 * Write multiple trajectories to a folder
	 */
	private async writeTrajectoriesToFolder(
		trajectories: Map<string, IAgentTrajectory>,
		saveDir: vscode.Uri,
		pathMapping: Map<string, string>
	): Promise<void> {
		for (const [sessionId, trajectory] of trajectories) {
			const filename = this.getTrajectoryFilename(sessionId, pathMapping);
			const fileUri = vscode.Uri.joinPath(saveDir, filename);
			const content = JSON.stringify(trajectory, null, 2);
			await this.fileSystemService.writeFile(fileUri, Buffer.from(content, 'utf8'));
		}
	}

	/**
	 * Prompt user for folder selection
	 */
	private async promptForFolder(title: string): Promise<vscode.Uri | undefined> {
		const dialogResult = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title,
			defaultUri: vscode.Uri.file(os.homedir())
		});
		return dialogResult?.[0];
	}

	private async exportTrajectories(savePath?: string): Promise<void> {
		const trajectories = this.trajectoryLogger.getAllTrajectories();

		if (trajectories.size === 0) {
			vscode.window.showInformationMessage('No trajectories found to export.');
			return;
		}

		const saveDir = savePath
			? vscode.Uri.file(savePath)
			: await this.promptForFolder('Select Folder to Export Trajectories');

		if (!saveDir) {
			return; // User cancelled
		}

		try {
			const pathMapping = this.buildTrajectoryPathMapping(trajectories);
			await this.writeTrajectoriesToFolder(trajectories, saveDir, pathMapping);

			const revealAction = 'Reveal in Explorer';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported ${trajectories.size} trajectories to ${saveDir.fsPath}`,
				revealAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveDir);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectories: ${error instanceof Error ? error.message : String(error)}`);
		}
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

		const pathMapping = this.buildTrajectoryPathMapping(trajectoriesToExport);
		const isSingleFile = trajectoriesToExport.size === 1;

		let saveDir: vscode.Uri;
		let singleFileUri: vscode.Uri | undefined;

		if (isSingleFile) {
			// Use showSaveDialog with predetermined filename for single file export
			const suggestedFilename = this.getTrajectoryFilename(sessionId, pathMapping);
			const saveResult = await vscode.window.showSaveDialog({
				title: 'Export Trajectory',
				defaultUri: vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), suggestedFilename),
				filters: { 'Trajectory Files': [TRAJECTORY_FILE_EXTENSION.slice(1)] }
			});

			if (!saveResult) {
				return; // User cancelled
			}

			singleFileUri = saveResult;
			saveDir = vscode.Uri.joinPath(saveResult, '..');
		} else {
			// Use folder selection for multiple files
			const folderUri = await this.promptForFolder('Select Folder to Export Trajectories');
			if (!folderUri) {
				return; // User cancelled
			}
			saveDir = folderUri;
		}

		try {
			if (isSingleFile && singleFileUri) {
				// Export single file using the user-specified path
				const [, trajectory] = [...trajectoriesToExport][0];
				const content = JSON.stringify(trajectory, null, 2);
				await this.fileSystemService.writeFile(singleFileUri, Buffer.from(content, 'utf8'));
			} else {
				await this.writeTrajectoriesToFolder(trajectoriesToExport, saveDir, pathMapping);
			}

			const subagentCount = trajectoriesToExport.size - 1;
			const subagentMsg = subagentCount > 0 ? ` (including ${subagentCount} subagent ${subagentCount === 1 ? 'trajectory' : 'trajectories'})` : '';
			const exportPath = isSingleFile && singleFileUri ? singleFileUri.fsPath : saveDir.fsPath;

			const revealAction = 'Reveal in Explorer';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported trajectory${subagentMsg} to ${exportPath}`,
				revealAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', singleFileUri ?? saveDir);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectory: ${error instanceof Error ? error.message : String(error)}`);
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

	private sanitizeFilename(name: string): string {
		// Remove invalid filename characters
		return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
	}
}
