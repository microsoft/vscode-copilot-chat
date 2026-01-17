/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { TRAJECTORY_FILE_EXTENSION } from '../../../platform/trajectory/common/trajectoryTypes';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';

const exportTrajectoriesCommand = 'github.copilot.chat.debug.exportTrajectories';

/**
 * Command contribution for exporting agent trajectories
 */
export class TrajectoryExportCommands extends Disposable implements IExtensionContribution {
	readonly id = 'trajectoryExportCommands';

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
		@IInstantiationService _instantiationService: IInstantiationService
	) {
		super();
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

		// If only one trajectory, export it directly
		if (trajectories.size === 1) {
			const [sessionId, trajectory] = trajectories.entries().next().value;
			await this.exportSingleTrajectory(trajectory, sessionId, savePath);
			return;
		}

		// Multiple trajectories - export each to separate file
		await this.exportMultipleTrajectories(trajectories, savePath);
	}

	private async exportSingleTrajectory(
		trajectory: any,
		sessionId: string,
		savePath?: string
	): Promise<void> {
		let saveUri: vscode.Uri;

		if (savePath && typeof savePath === 'string') {
			saveUri = vscode.Uri.file(savePath);
		} else {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
			const defaultFilename = `${this.sanitizeFilename(sessionId)}_${timestamp}${TRAJECTORY_FILE_EXTENSION}`;

			const dialogResult = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: {
					'Trajectory JSON': ['json'],
					'All Files': ['*']
				},
				title: 'Export Agent Trajectory'
			});

			if (!dialogResult) {
				return; // User cancelled
			}
			saveUri = dialogResult;
		}

		try {
			const content = JSON.stringify(trajectory, null, 2);
			await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

			const revealAction = 'Reveal in Explorer';
			const openAction = 'Open File';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported trajectory to ${saveUri.fsPath}`,
				revealAction,
				openAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveUri);
			} else if (result === openAction) {
				await vscode.commands.executeCommand('vscode.open', saveUri);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectory: ${error}`);
		}
	}

	private async exportMultipleTrajectories(
		trajectories: Map<string, any>,
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
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
			let successCount = 0;

			for (const [sessionId, trajectory] of trajectories) {
				const filename = `${this.sanitizeFilename(sessionId)}_${timestamp}${TRAJECTORY_FILE_EXTENSION}`;
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
