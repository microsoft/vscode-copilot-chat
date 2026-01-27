/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { TRAJECTORY_BUNDLE_FILE_EXTENSION, TRAJECTORY_FILE_EXTENSION, type IAgentTrajectory, type IObservationResult, type ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
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

		// If only one trajectory, export it directly
		if (trajectories.size === 1) {
			const [sessionId, trajectory] = trajectories.entries().next().value!;
			await this.exportSingleTrajectory(trajectory, sessionId, savePath);
			return;
		}

		// If the caller provided a savePath, keep previous behavior (export main if possible).
		// The interactive picker is intended for command palette usage.
		if (savePath && typeof savePath === 'string') {
			const mainCandidate = this.pickMainTrajectory(trajectories);
			if (mainCandidate) {
				await this.exportSingleTrajectory(mainCandidate.trajectory, mainCandidate.sessionId, savePath);
				return;
			}
			await this.exportMultipleTrajectories(trajectories, savePath);
			return;
		}

		type ExportChoice = vscode.QuickPickItem & { exportKind: 'bundle' | 'main' | 'all' };
		const items: ExportChoice[] = [
			{
				label: 'Export bundle (single file)',
				description: 'Recommended for visualization: includes main + all subagents in one JSON',
				exportKind: 'bundle'
			},
			{
				label: 'Export main trajectory only',
				description: 'ATIF-style single trajectory (subagents referenced by session_id)',
				exportKind: 'main'
			},
			{
				label: 'Export all trajectories (separate files)',
				description: 'Writes one .trajectory.json per session; subagent filenames match trajectory_path',
				exportKind: 'all'
			}
		];

		const choice = await vscode.window.showQuickPick(items, {
			placeHolder: 'Export agent trajectories',
			ignoreFocusOut: true
		});

		if (!choice) {
			return;
		}

		switch (choice.exportKind) {
			case 'bundle':
				await this.exportTrajectoryBundle(trajectories);
				return;
			case 'main': {
				const mainCandidate = this.pickMainTrajectory(trajectories);
				if (mainCandidate) {
					await this.exportSingleTrajectory(mainCandidate.trajectory, mainCandidate.sessionId);
					return;
				}
				// If no obvious main found, export multiple as a safe fallback.
				await this.exportMultipleTrajectories(trajectories);
				return;
			}
			case 'all':
				await this.exportMultipleTrajectories(trajectories);
				return;
		}

		// Should be unreachable.
	}

	private pickMainTrajectory(trajectories: Map<string, IAgentTrajectory>): { sessionId: string; trajectory: IAgentTrajectory } | undefined {
		let best: { sessionId: string; trajectory: IAgentTrajectory; score: number } | undefined;

		for (const [sessionId, trajectory] of trajectories) {
			const steps: ITrajectoryStep[] = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
			let spawnedSubagents = 0;
			let toolCalls = 0;
			for (const step of steps) {
				toolCalls += step.tool_calls?.length ?? 0;
				const results: IObservationResult[] = Array.isArray(step.observation?.results) ? step.observation.results : [];
				for (const r of results) {
					spawnedSubagents += r.subagent_trajectory_ref?.length ?? 0;
				}
			}

			// Prefer trajectories that actually spawned subagents.
			// Tie-break by total tool calls and step count.
			const score = (spawnedSubagents * 1000) + (toolCalls * 10) + steps.length;
			if (!best || score > best.score) {
				best = { sessionId, trajectory, score };
			}
		}

		if (!best || best.score === 0) {
			return undefined;
		}
		return { sessionId: best.sessionId, trajectory: best.trajectory };
	}

	private async exportTrajectoryBundle(trajectories: Map<string, IAgentTrajectory>): Promise<void> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
		const main = this.pickMainTrajectory(trajectories);
		const bundle = {
			schema_version: 'VSCode-Copilot-TrajectoryBundle-v1.0',
			exported_at: new Date().toISOString(),
			root_session_id: main?.sessionId ?? [...trajectories.keys()][0],
			trajectories_by_id: Object.fromEntries([...trajectories.entries()])
		};

		const defaultFilename = `${this.sanitizeFilename(bundle.root_session_id)}_${timestamp}${TRAJECTORY_BUNDLE_FILE_EXTENSION}`;
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
			filters: {
				'Trajectory Bundle JSON': ['json'],
				'All Files': ['*']
			},
			title: 'Export Agent Trajectory Bundle'
		});

		if (!saveUri) {
			return;
		}

		try {
			const content = JSON.stringify(bundle, null, 2);
			await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

			const revealAction = 'Reveal in Explorer';
			const openAction = 'Open File';
			const result = await vscode.window.showInformationMessage(
				`Successfully exported trajectory bundle to ${saveUri.fsPath}`,
				revealAction,
				openAction
			);

			if (result === revealAction) {
				await vscode.commands.executeCommand('revealFileInOS', saveUri);
			} else if (result === openAction) {
				await vscode.commands.executeCommand('vscode.open', saveUri);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export trajectory bundle: ${error}`);
		}
	}

	private async exportSingleTrajectory(
		trajectory: IAgentTrajectory,
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
