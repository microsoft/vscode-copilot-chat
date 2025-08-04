/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Disposable } from 'vscode';
import { IExtensionsService } from '../../../platform/extensions/common/extensionsService';
import { ILogService } from '../../../platform/log/common/logService';
import { IReviewService } from '../../../platform/review/common/reviewService';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Extension, l10n, Uri } from '../../../vscodeTypes';
import { API, RepositoryDescription } from '../../githubPullRequest';
import { GitHubPullRequestTitleAndDescriptionGenerator } from '../../prompt/node/githubPullRequestTitleAndDescriptionGenerator';
import { GitHubPullRequestReviewerCommentsProvider } from '../../review/node/githubPullRequestReviewerCommentsProvider';

export class GitHubPullRequestProviders implements Disposable {
	private gitHubExtensionApi: API | undefined;
	protected readonly disposables: DisposableStore = new DisposableStore();

	constructor(
		@ILogService protected readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IReviewService private readonly reviewService: IReviewService,
		@IExtensionsService private readonly extensionService: IExtensionsService,
	) {
		this.initializeGitHubPRExtensionApi();
	}
	dispose() {
		this.disposables.dispose();
	}

	private getExtension(): Extension<API> | undefined {
		return this.extensionService.getExtension('github.vscode-pull-request-github');
	}

	private initializeGitHubPRExtensionApi() {
		let githubPRExtension = this.getExtension();

		const initialize = async () => {
			if (githubPRExtension) {
				const extension = await githubPRExtension!.activate();
				this.logService.info('Successfully activated the GitHub.vscode-pull-request-github extension.');

				this.gitHubExtensionApi = extension;
				this.registerTitleAndDescriptionProvider();
				this.registerReviewerCommentsProvider();
			}
		};

		if (githubPRExtension) {
			initialize();
		} else {
			this.logService.info('GitHub.vscode-pull-request-github extension is not yet activated.');

			const listener = this.extensionService.onDidChange(() => {
				githubPRExtension = this.getExtension();
				if (githubPRExtension) {
					initialize();
					listener.dispose();
				}
			});
			this.disposables.add(listener);
		}
	}

	private titleAndDescriptionProvider: GitHubPullRequestTitleAndDescriptionGenerator | undefined;
	private async registerTitleAndDescriptionProvider() {
		if (!this.gitHubExtensionApi) {
			return;
		}
		try {
			if (!this.titleAndDescriptionProvider) {
				this.titleAndDescriptionProvider = this.disposables.add(this.instantiationService.createInstance(GitHubPullRequestTitleAndDescriptionGenerator));
			}
			// This string "Copilot" needs to be in here. It's how we an tell which provider to use in the PR extension.
			this.disposables.add(this.gitHubExtensionApi.registerTitleAndDescriptionProvider(l10n.t('Generate with Copilot'/* DO NOT CHANGE THIS STRING WITHOUT TALKING TO alexr00 */), this.titleAndDescriptionProvider));
			this.logService.info('Successfully registered GitHub PR title and description provider.');
		} catch (e) {
			// Catch errors in case there's a breaking API change.
		}
	}

	private reviewerCommentsProvider: GitHubPullRequestReviewerCommentsProvider | undefined;
	private async registerReviewerCommentsProvider() {
		if (!this.gitHubExtensionApi) {
			return;
		}

		if (!this.reviewService.isReviewDiffEnabled()) {
			return;
		}

		try {
			if (!this.reviewerCommentsProvider) {
				this.reviewerCommentsProvider = this.instantiationService.createInstance(GitHubPullRequestReviewerCommentsProvider);
			}
			this.disposables.add(this.gitHubExtensionApi.registerReviewerCommentsProvider(l10n.t('Copilot'), this.reviewerCommentsProvider));
			this.logService.info('Successfully registered GitHub PR reviewer comments provider.');
		} catch (e) {
			// Catch errors in case there's a breaking API change.
		}
	}

	public async getRepositoryDescription(uri: Uri): Promise<RepositoryDescription | undefined> {
		try {
			// Wait for gitHubExtensionApi to be initialized if not already
			if (!this.gitHubExtensionApi) {
				// Try to get and activate the extension if possible
				const githubPRExtension = this.getExtension();
				if (githubPRExtension) {
					const extension = await githubPRExtension.activate();
					this.gitHubExtensionApi = extension;
				} else {
					this.logService.warn('GitHub.vscode-pull-request-github extension API is not available.');
					return undefined;
				}
			}

			if (!this.gitHubExtensionApi.getRepositoryDescription) {
				return undefined;
			}

			return await this.gitHubExtensionApi.getRepositoryDescription(uri);
		} catch (error) {
			this.logService.error('Failed to get repository description from GitHub.vscode-pull-request-github extension.', error);
			return undefined;
		}
	}
}
