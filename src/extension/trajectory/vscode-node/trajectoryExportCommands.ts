/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { TRAJECTORY_FILE_EXTENSION, type IAgentTrajectory, type IObservationResult, type ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { TrajectoryLoggerAdapter } from '../../../platform/trajectory/node/trajectoryLoggerAdapter';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { renderToolResultToStringNoBudget } from '../../prompt/vscode-node/requestLoggerToolResult';

const exportTrajectoriesCommand = 'github.copilot.chat.debug.exportTrajectories';

/**
 * Command contribution for exporting agent trajectories
 */
export class TrajectoryExportCommands extends Disposable implements IExtensionContribution {
	readonly id = 'trajectoryExportCommands';

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
		@IRequestLogger requestLogger: IRequestLogger,
		@IInstantiationService _instantiationService: IInstantiationService
	) {
		super();
		// Initialize adapter to bridge RequestLogger to TrajectoryLogger
		// The adapter subscribes to RequestLogger events and populates TrajectoryLogger
		this._register(new TrajectoryLoggerAdapter(requestLogger, trajectoryLogger, renderToolResultToStringNoBudget));
		this.registerCommands();
	}

	private registerCommands(): void {
		this._register(vscode.commands.registerCommand(exportTrajectoriesCommand, async (savePath?: string) => {
			await this.exportTrajectories(savePath);
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
