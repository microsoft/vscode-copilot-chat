/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { Repository } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';
import { getRepoId } from '../vscode/copilotCodingAgentUtils';

export interface GitRepoInfo {
	repository: Repository;
	remoteName: string;
	baseRef: string;
}

export class CopilotCloudGitOperationsManager {
	constructor(
		private readonly logService: ILogService,
		private readonly gitService: IGitService,
		private readonly gitExtensionService: IGitExtensionService,
		private readonly configurationService: IConfigurationService
	) { }

	private get autoCommitAndPushEnabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.AgentDelegateAutoCommitAndPush);
	}

	async repoInfo(): Promise<GitRepoInfo> {
		// TODO: support selecting remote
		// await this.promptAndUpdatePreferredGitHubRemote(true);
		const repoId = await getRepoId(this.gitService);
		if (!repoId) {
			throw new Error(vscode.l10n.t('Repository information is not available. Open a GitHub repository to continue with cloud agent.'));
		}
		const currentRepository = this.gitService.activeRepository.get();
		if (!currentRepository) {
			throw new Error(vscode.l10n.t('No active repository found. Open a GitHub repository to continue with cloud agent.'));
		}
		const git = this.gitExtensionService.getExtensionApi();
		const repo = git?.getRepository(currentRepository?.rootUri);
		// Checks if user has permission to access the repository
		if (!repo) {
			throw new Error(
				vscode.l10n.t(
					'Unable to access {0}. Please check your permissions and try again.',
					`\`${repoId.org}/${repoId.repo}\``
				)
			);
		}
		return {
			repository: repo,
			remoteName: repo.state.HEAD?.upstream?.remote ?? currentRepository.upstreamRemote ?? repo.state.remotes?.[0]?.name ?? 'origin',
			baseRef: currentRepository.headBranchName ?? 'main'
		};
	}

	async validateRemoteHasBaseRef(): Promise<void> {
		const { repository, remoteName, baseRef } = await this.repoInfo();
		if (repository && remoteName && baseRef) {
			try {
				const remoteBranches =
					(await repository.getBranches({ remote: true }))
						.filter(b => b.remote); // Has an associated remote
				const expectedRemoteBranch = `${remoteName}/${baseRef}`;
				const alternateNames = new Set<string>([
					expectedRemoteBranch,
					`refs/remotes/${expectedRemoteBranch}`,
					baseRef
				]);
				const hasRemoteBranch = remoteBranches.some(branch => {
					if (!branch.name) {
						return false;
					}
					if (branch.remote && branch.remote !== remoteName) {
						return false;
					}
					const candidateName =
						(branch.remote && branch.name.startsWith(branch.remote + '/'))
							? branch.name
							: `${branch.remote}/${branch.name}`;
					return alternateNames.has(candidateName);
				});

				if (!hasRemoteBranch) {
					if (this.autoCommitAndPushEnabled) {
						this.logService.warn(`Base branch '${expectedRemoteBranch}' not found on remote. Auto-pushing because autoCommitAndPush is enabled.`);
						await repository.push(remoteName, baseRef, true);
					} else {
						this.logService.warn(`Base branch '${expectedRemoteBranch}' not found on remote.`);
						throw new Error(vscode.l10n.t('The branch \'{0}\' does not exist on remote \'{1}\'. Please push the branch and try again.', baseRef, remoteName));
					}
				}
			} catch (error) {
				this.logService.error(`Failed to verify remote branch for cloud agent: ${error instanceof Error ? error.message : String(error)}`);
				throw new Error(vscode.l10n.t('Unable to verify that branch \'{0}\' exists on remote \'{1}\'. Please ensure the remote branch is available and try again.', baseRef, remoteName));
			}
		}
	}


	async commitAndPushChanges(): Promise<string> {
		const { repository, remoteName, baseRef } = await this.repoInfo();
		const asyncBranch = await this.generateRandomBranchName(repository, 'copilot');

		const commitMessage = vscode.l10n.t('Checkpoint from VS Code for cloud agent session');
		try {
			await repository.createBranch(asyncBranch, true);
			await this.performCommit(asyncBranch, repository, commitMessage);
			await repository.push(remoteName, asyncBranch, true);
			await this.switchBackToBaseRef(repository, baseRef, asyncBranch);
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

	private async switchBackToBaseRef(repository: Repository, baseRef: string, newRef: string): Promise<void> {
		if (repository.state.HEAD?.name !== baseRef) {
			await repository.checkout(baseRef);
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
