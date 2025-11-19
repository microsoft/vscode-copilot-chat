/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';

export interface GitRepoInfo {
	repository: Repository;
	remoteName: string;
	baseRef: string;
}

export class CopilotCloudGitOperationsManager {
	constructor(private readonly logService: ILogService) { }

	async commitAndPushChanges(repoInfo: GitRepoInfo): Promise<string> {
		const { repository, remoteName, baseRef } = repoInfo;
		const asyncBranch = await this.generateRandomBranchName(repository, 'copilot');

		const commitMessage = vscode.l10n.t('Checkpoint from VS Code for cloud agent session');
		try {
			await repository.createBranch(asyncBranch, true);
			await this.performCommit(asyncBranch, repository, commitMessage);
			await repository.push(remoteName, asyncBranch, true);
			this.showBranchSwitchNotification(repository, baseRef, asyncBranch);
			return asyncBranch;
		} catch (error) {
			await this.rollbackToOriginalBranch(repository, baseRef);
			this.logService.error(`Failed to automatically commit and push your changes: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(vscode.l10n.t('Failed to automatically commit and push your changes. Please commit or stash your changes manually and try again.'));
		}
	}

	private async performCommit(asyncBranch: string, repository: Repository, commitMessage: string): Promise<void> {
		try {
			await repository.commit(commitMessage, { all: true });
			if (repository.state.HEAD?.name !== asyncBranch || repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0) {
				throw new Error(vscode.l10n.t('Uncommitted changes still detected.'));
			}
		} catch (error) {
			const commitSuccessful = await this.handleInteractiveCommit(repository);
			if (!commitSuccessful) {
				throw new Error(vscode.l10n.t('Failed to commit changes. Please commit or stash your changes manually before using the cloud agent.'));
			}
		}
	}

	private async handleInteractiveCommit(repository: Repository): Promise<boolean> {
		const COMMIT_YOUR_CHANGES = vscode.l10n.t('Commit your changes to continue cloud agent session. Close integrated terminal to cancel.');
		return vscode.window.withProgress({
			title: COMMIT_YOUR_CHANGES,
			cancellable: true,
			location: vscode.ProgressLocation.Notification
		}, async (_, token) => {
			return new Promise<boolean>((resolve) => {
				const startingCommit = repository.state.HEAD?.commit;
				const terminal = vscode.window.createTerminal({
					name: 'GitHub Copilot Cloud Agent',
					cwd: repository.rootUri.fsPath,
					message: `\x1b[1m${COMMIT_YOUR_CHANGES}\x1b[0m`
				});

				terminal.show();

				let disposed = false;
				let timeoutId: TimeoutHandle | undefined = undefined;
				let stateListener: vscode.Disposable | undefined = undefined;
				let disposalListener: vscode.Disposable | undefined = undefined;
				let cancellationListener: vscode.Disposable | undefined = undefined;
				const cleanup = () => {
					if (disposed) {
						return;
					}
					disposed = true;
					clearTimeout(timeoutId);
					stateListener?.dispose();
					disposalListener?.dispose();
					cancellationListener?.dispose();
					terminal.dispose();
				};

				if (token) {
					cancellationListener = token.onCancellationRequested(() => {
						cleanup();
						resolve(false);
					});
				}

				stateListener = repository.state.onDidChange(() => {
					if (repository.state.HEAD?.commit !== startingCommit) {
						cleanup();
						resolve(true);
					}
				});

				timeoutId = setTimeout(() => {
					cleanup();
					resolve(false);
				}, 5 * 60 * 1000);

				disposalListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
					if (closedTerminal === terminal) {
						setTimeout(() => {
							if (!disposed) {
								cleanup();
								resolve(repository.state.HEAD?.commit !== startingCommit);
							}
						}, 1000);
					}
				});
			});
		});
	}

	private showBranchSwitchNotification(repository: Repository, baseRef: string, newRef: string): void {
		if (repository.state.HEAD?.name !== baseRef) {
			const SWAP_BACK_TO_ORIGINAL_BRANCH = vscode.l10n.t('Swap back to \'{0}\'', baseRef);
			vscode.window.showInformationMessage(
				vscode.l10n.t('Pending changes pushed to remote branch \'{0}\'.', newRef),
				SWAP_BACK_TO_ORIGINAL_BRANCH,
			).then(async (selection) => {
				if (selection === SWAP_BACK_TO_ORIGINAL_BRANCH) {
					await repository.checkout(baseRef);
				}
			});
		}
	}

	private async rollbackToOriginalBranch(repository: Repository, baseRef: string): Promise<void> {
		if (repository.state.HEAD?.name !== baseRef) {
			try {
				await repository.checkout(baseRef);
			} catch (error) {
				this.logService.error(`Failed to checkout back to original branch '${baseRef}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async generateRandomBranchName(repository: Repository, prefix: string): Promise<string> {
		for (let index = 0; index < 5; index++) {
			const randomName = `${prefix}/vscode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			try {
				const refs = await repository.getRefs({ pattern: `refs/heads/${randomName}` });
				if (!refs || refs.length === 0) {
					return randomName;
				}
			} catch (error) {
				this.logService.warn(`Failed to check refs for ${randomName}: ${error instanceof Error ? error.message : String(error)}`);
				return randomName;
			}
		}

		return `${prefix}/vscode-${Date.now().toString(36)}`;
	}
}
