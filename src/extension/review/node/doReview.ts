/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { Selection, TextEditor, Uri } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IEnvService } from '../../../platform/env/common/envService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { INotificationService, Progress, ProgressLocation } from '../../../platform/notification/common/notificationService';
import { IReviewService, ReviewComment } from '../../../platform/review/common/reviewService';
import { IScopeSelector } from '../../../platform/scopeSelection/common/scopeSelection';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import * as path from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { FeedbackGenerator, FeedbackResult } from '../../prompt/node/feedbackGenerator';
import { CurrentChange, CurrentChangeInput } from '../../prompts/node/feedback/currentChange';
import { githubReview } from './githubReviewAgent';


export class ReviewSession {
	private inProgress?: CancellationTokenSource;

	constructor(
		@IScopeSelector private readonly scopeSelector: IScopeSelector,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IReviewService private readonly reviewService: IReviewService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@IGitExtensionService private readonly gitExtensionService: IGitExtensionService,
		@IDomainService private readonly domainService: IDomainService,
		@ICAPIClientService private readonly capiClientService: ICAPIClientService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@IEnvService private readonly envService: IEnvService,
		@IIgnoreService private readonly ignoreService: IIgnoreService,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
	) { }

	async review(
		group: ReviewGroup,
		progressLocation: ProgressLocation,
		cancellationToken?: CancellationToken
	): Promise<FeedbackResult | undefined> {
		if (!await this.checkAuthentication()) {
			return undefined;
		}

		const editor = this.tabsAndEditorsService.activeTextEditor;
		const selection = await this.resolveSelection(group, editor);
		if (group === 'selection' && selection === undefined) {
			return undefined;
		}

		const title = getReviewTitle(group, editor);
		return this.executeWithProgress(group, editor, title, progressLocation, cancellationToken);
	}

	/**
	 * Checks if the user is authenticated. Shows sign-in dialog if not.
	 * @returns true if authenticated, false if user needs to sign in
	 */
	private async checkAuthentication(): Promise<boolean> {
		if (this.authService.copilotToken?.isNoAuthUser) {
			await this.notificationService.showQuotaExceededDialog({ isNoAuthUser: true });
			return false;
		}
		return true;
	}

	/**
	 * Resolves the selection for 'selection' group reviews.
	 * @returns The selection range, or undefined if selection cannot be determined
	 */
	private async resolveSelection(group: ReviewGroup, editor: TextEditor | undefined): Promise<Selection | undefined> {
		if (group !== 'selection') {
			return editor?.selection;
		}
		if (!editor) {
			return undefined;
		}
		let selection = editor.selection;
		if (!selection || selection.isEmpty) {
			try {
				const rangeOfEnclosingSymbol = await this.scopeSelector.selectEnclosingScope(editor, {
					reason: l10n.t('Select an enclosing range to review'),
					includeBlocks: true
				});
				if (!rangeOfEnclosingSymbol) {
					return undefined;
				}
				selection = rangeOfEnclosingSymbol;
			} catch (err) {
				if (isCancellationError(err)) {
					return undefined;
				}
				throw err;
			}
		}
		return selection;
	}

	/**
	 * Executes the review with progress UI.
	 */
	private async executeWithProgress(
		group: ReviewGroup,
		editor: TextEditor | undefined,
		title: string,
		progressLocation: ProgressLocation,
		cancellationToken?: CancellationToken
	): Promise<FeedbackResult | undefined> {
		return this.notificationService.withProgress({
			location: progressLocation,
			title,
			cancellable: true,
		}, async (_progress, progressToken) => {
			if (this.inProgress) {
				this.inProgress.cancel();
			}
			const tokenSource = this.inProgress = new CancellationTokenSource(
				cancellationToken ? combineCancellationTokens(cancellationToken, progressToken) : progressToken
			);

			this.reviewService.removeReviewComments(this.reviewService.getReviewComments());
			const progress: Progress<ReviewComment[]> = {
				report: comments => {
					if (!tokenSource.token.isCancellationRequested) {
						this.reviewService.addReviewComments(comments);
					}
				}
			};

			const result = await this.performReview(group, editor, progress, tokenSource);

			if (tokenSource.token.isCancellationRequested) {
				return { type: 'cancelled' };
			}

			await this.handleResult(result);
			return result;
		});
	}

	/**
	 * Performs the actual code review using either GitHub agent or legacy feedback generator.
	 */
	private async performReview(
		group: ReviewGroup,
		editor: TextEditor | undefined,
		progress: Progress<ReviewComment[]>,
		tokenSource: CancellationTokenSource
	): Promise<FeedbackResult> {
		try {
			const copilotToken = await this.authService.getCopilotToken();
			const canUseGitHubAgent = copilotToken.isCopilotCodeReviewEnabled;

			if (canUseGitHubAgent) {
				return await githubReview(
					this.logService, this.gitExtensionService, this.authService,
					this.capiClientService, this.domainService, this.fetcherService,
					this.envService, this.ignoreService, this.workspaceService,
					this.customInstructionsService, group, editor, progress, tokenSource.token
				);
			} else {
				const legacyGroup = typeof group === 'object' && 'group' in group ? group.group : group;
				return await review(
					this.instantiationService, this.gitExtensionService, this.workspaceService,
					legacyGroup, editor, progress, tokenSource.token
				);
			}
		} catch (err) {
			this.logService.error(err, 'Error during code review');
			return { type: 'error', reason: err.message, severity: err.severity };
		} finally {
			if (tokenSource === this.inProgress) {
				this.inProgress = undefined;
			}
			tokenSource.dispose();
		}
	}

	/**
	 * Handles the review result by showing appropriate notifications.
	 */
	private async handleResult(result: FeedbackResult): Promise<void> {
		if (result.type === 'error') {
			const showLog = l10n.t('Show Log');
			const res = await (result.severity === 'info'
				? this.notificationService.showInformationMessage(result.reason, { modal: true })
				: this.notificationService.showInformationMessage(
					l10n.t('Code review generation failed.'),
					{ modal: true, detail: result.reason },
					showLog
				)
			);
			if (res === showLog) {
				this.logService.show();
			}
		} else if (result.type === 'success' && result.comments.length === 0) {
			if (result.excludedComments?.length) {
				const show = l10n.t('Show Skipped');
				const res = await this.notificationService.showInformationMessage(
					l10n.t('Reviewing your code did not provide any feedback.'),
					{
						modal: true,
						detail: l10n.t('{0} comments were skipped due to low confidence.', result.excludedComments.length)
					},
					show
				);
				if (res === show) {
					this.reviewService.addReviewComments(result.excludedComments);
				}
			} else {
				await this.notificationService.showInformationMessage(
					l10n.t('Reviewing your code did not provide any feedback.'),
					{
						modal: true,
						detail: result.reason || l10n.t('Copilot only keeps its highest confidence comments to reduce noise and keep you focused.')
					}
				);
			}
		}
	}
}

export type ReviewGroup = 'selection' | 'index' | 'workingTree' | 'all' | { group: 'index' | 'workingTree'; file: Uri } | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] };

/**
 * Gets the progress title for a review operation based on the review group type.
 */
export function getReviewTitle(group: ReviewGroup, editor?: TextEditor): string {
	if (group === 'selection') {
		return l10n.t('Reviewing selected code in {0}...', path.posix.basename(editor!.document.uri.path));
	}
	if (group === 'index') {
		return l10n.t('Reviewing staged changes...');
	}
	if (group === 'workingTree') {
		return l10n.t('Reviewing unstaged changes...');
	}
	if (group === 'all') {
		return l10n.t('Reviewing uncommitted changes...');
	}
	if ('repositoryRoot' in group) {
		return l10n.t('Reviewing changes...');
	}
	if (group.group === 'index') {
		return l10n.t('Reviewing staged changes in {0}...', path.posix.basename(group.file.path));
	}
	return l10n.t('Reviewing unstaged changes in {0}...', path.posix.basename(group.file.path));
}

export function combineCancellationTokens(token1: CancellationToken, token2: CancellationToken): CancellationToken {
	const combinedSource = new CancellationTokenSource();

	const subscription1 = token1.onCancellationRequested(() => {
		combinedSource.cancel();
		cleanup();
	});

	const subscription2 = token2.onCancellationRequested(() => {
		combinedSource.cancel();
		cleanup();
	});

	function cleanup() {
		subscription1.dispose();
		subscription2.dispose();
	}

	return combinedSource.token;
}

async function review(
	instantiationService: IInstantiationService,
	gitExtensionService: IGitExtensionService,
	workspaceService: IWorkspaceService,
	group: 'selection' | 'index' | 'workingTree' | 'all' | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] },
	editor: TextEditor | undefined,
	progress: Progress<ReviewComment[]>,
	cancellationToken: CancellationToken
) {
	const feedbackGenerator = instantiationService.createInstance(FeedbackGenerator);
	const input: CurrentChangeInput[] = [];
	if (group === 'index' || group === 'workingTree' || group === 'all') {
		const changes = await CurrentChange.getCurrentChanges(gitExtensionService, group);
		const documentsAndChanges = await Promise.all<CurrentChangeInput | undefined>(changes.map(async (change) => {
			try {
				const document = await workspaceService.openTextDocument(change.uri);
				return {
					document: TextDocumentSnapshot.create(document),
					relativeDocumentPath: path.relative(change.repository.rootUri.fsPath, change.uri.fsPath),
					change,
				};
			} catch (err) {
				try {
					if ((await workspaceService.fs.stat(change.uri)).type === FileType.File) {
						throw err;
					}
					return undefined;
				} catch (inner) {
					if (inner.code === 'FileNotFound') {
						return undefined;
					}
					throw err;
				}
			}
		}));
		documentsAndChanges.map(i => {
			if (i) {
				input.push(i);
			}
		});
	} else if (group === 'selection') {
		input.push({
			document: TextDocumentSnapshot.create(editor!.document),
			relativeDocumentPath: path.basename(editor!.document.uri.fsPath),
			selection: editor!.selection,
		});
	} else {
		for (const patch of group.patches) {
			const uri = URI.parse(patch.fileUri);
			input.push({
				document: TextDocumentSnapshot.create(await workspaceService.openTextDocument(uri)),
				relativeDocumentPath: path.relative(group.repositoryRoot, uri.fsPath),
				change: await CurrentChange.getChanges(gitExtensionService, URI.file(group.repositoryRoot), uri, patch.patch)
			});
		}
	}
	return feedbackGenerator.generateComments(input, cancellationToken, progress);
}