/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { QuickPickItem, Selection, TextEditor, Uri } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IDialogService } from '../../../platform/dialog/common/dialogService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { INotificationService, Progress, ProgressLocation } from '../../../platform/notification/common/notificationService';
import { CodeReviewInput, CodeReviewResult, toCodeReviewResult } from '../../../platform/review/common/reviewCommand';
import { IReviewService, ReviewComment } from '../../../platform/review/common/reviewService';
import { IScopeSelector } from '../../../platform/scopeSelection/common/scopeSelection';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import * as path from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { FeedbackGenerator, FeedbackResult } from '../../prompt/node/feedbackGenerator';
import { CurrentChange, CurrentChangeInput } from '../../prompts/node/feedback/currentChange';
import { githubReview, githubReviewFileUris } from './githubReviewAgent';

/**
 * Dependencies for handleReviewResult function.
 */
export interface HandleResultDependencies {
	notificationService: INotificationService;
	logService: ILogService;
	reviewService: IReviewService;
}

/**
 * Handles the review result by showing appropriate notifications.
 * Extracted for testability.
 */
export async function handleReviewResult(
	result: FeedbackResult,
	deps: HandleResultDependencies
): Promise<void> {
	const { notificationService, logService, reviewService } = deps;

	if (result.type === 'error') {
		const showLog = l10n.t('Show Log');
		const res = await (result.severity === 'info'
			? notificationService.showInformationMessage(result.reason, { modal: true })
			: notificationService.showInformationMessage(
				l10n.t('Code review generation failed.'),
				{ modal: true, detail: result.reason },
				showLog
			)
		);
		if (res === showLog) {
			logService.show();
		}
	} else if (result.type === 'success' && result.comments.length === 0) {
		if (result.excludedComments?.length) {
			const show = l10n.t('Show Skipped');
			const res = await notificationService.showInformationMessage(
				l10n.t('Reviewing your code did not provide any feedback.'),
				{
					modal: true,
					detail: l10n.t('{0} comments were skipped due to low confidence.', result.excludedComments.length)
				},
				show
			);
			if (res === show) {
				reviewService.addReviewComments(result.excludedComments);
			}
		} else {
			await notificationService.showInformationMessage(
				l10n.t('Reviewing your code did not provide any feedback.'),
				{
					modal: true,
					detail: result.reason || l10n.t('Copilot only keeps its highest confidence comments to reduce noise and keep you focused.')
				}
			);
		}
	}
}

// Module-level variable to track in-progress review across all sessions.
// This ensures that starting a new review cancels any previous in-progress review.
let inProgress: CancellationTokenSource | undefined;

/** @internal Exposed for testing only. Sets the module-level inProgress state. */
export function _setInProgressForTesting(tokenSource: CancellationTokenSource | undefined): void {
	inProgress = tokenSource;
}

export class ReviewSession {

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
		@IDialogService private readonly dialogService: IDialogService,
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

		// If user has no text selected and invoked review via 'selection' group,
		// show the scope picker to let them choose what to review
		if (group === 'selection' && (!editor?.selection || editor.selection.isEmpty)) {
			const picked = await this.showReviewScopePicker(editor);
			if (!picked) {
				return undefined;
			}
			group = picked;
		}

		// For diff-based groups, check upfront if there are any changes to review
		const noChangesMessage = this.getNoChangesMessage(group);
		if (noChangesMessage) {
			await this.notificationService.showInformationMessage(noChangesMessage);
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
	 * Checks if there are changes available for the given review group.
	 * @returns A user-facing message if there are no changes, or undefined if changes exist
	 */
	private getNoChangesMessage(group: ReviewGroup): string | undefined {
		if (typeof group !== 'string' || group === 'selection' || group === 'file') {
			return undefined;
		}
		const git = this.gitExtensionService.getExtensionApi();
		if (!git || git.repositories.length === 0) {
			return l10n.t('No Git repository found. Open a folder with a Git repository to review changes.');
		}
		const hasChanges = git.repositories.some(repo => {
			if (group === 'workingTree' || group === 'all') {
				if (repo.state.workingTreeChanges.length > 0 || repo.state.untrackedChanges.length > 0) {
					return true;
				}
			}
			if (group === 'index' || group === 'all') {
				if (repo.state.indexChanges.length > 0) {
					return true;
				}
			}
			return false;
		});
		if (!hasChanges) {
			if (group === 'workingTree') {
				return l10n.t('No unstaged changes to review.');
			}
			if (group === 'index') {
				return l10n.t('No staged changes to review.');
			}
			return l10n.t('No uncommitted changes to review.');
		}
		return undefined;
	}

	/**
	 * Shows a quick pick to let the user choose a review scope when no selection is available.
	 * @returns The chosen ReviewGroup, or undefined if the user dismissed the picker
	 */
	private async showReviewScopePicker(editor: TextEditor | undefined): Promise<ReviewGroup | 'file' | undefined> {
		interface ReviewScopeItem extends QuickPickItem {
			readonly group: ReviewGroup | 'file';
		}

		const items: ReviewScopeItem[] = [];
		if (editor) {
			items.push({
				label: l10n.t('$(file) Current File'),
				description: path.posix.basename(editor.document.uri.path),
				group: 'file',
			});
		}

		const git = this.gitExtensionService.getExtensionApi();
		if (git && git.repositories.length > 0 && this.workspaceService.getWorkspaceFolders().length > 0) {
			const hasUnstaged = git.repositories.some(r => r.state.workingTreeChanges.length > 0 || r.state.untrackedChanges.length > 0);
			const hasStaged = git.repositories.some(r => r.state.indexChanges.length > 0);
			if (hasUnstaged) {
				items.push({ label: l10n.t('$(diff) Unstaged Changes'), group: 'workingTree' });
			}
			if (hasStaged) {
				items.push({ label: l10n.t('$(check) Staged Changes'), group: 'index' });
			}
			if (hasUnstaged || hasStaged) {
				items.push({ label: l10n.t('$(git-commit) All Uncommitted Changes'), group: 'all' });
			}
		}

		if (items.length === 0) {
			await this.notificationService.showInformationMessage(
				l10n.t('No code selected for review. Select code in the editor or open a folder with a Git repository.')
			);
			return undefined;
		}

		const picked = await this.dialogService.showQuickPick(items, {
			placeHolder: l10n.t('Select a scope for code review'),
		});
		return picked?.group;
	}

	/**
	 * Resolves the selection for 'selection' group reviews.
	 * @returns The selection range, or undefined if selection cannot be determined
	 */
	private async resolveSelection(group: ReviewGroup, editor: TextEditor | undefined): Promise<Selection | undefined> {
		if (group === 'file') {
			// "Current File" — no selection needed, the full file content is used
			return editor?.selection;
		}
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
				if (!rangeOfEnclosingSymbol || rangeOfEnclosingSymbol.isEmpty) {
					return undefined;
				}
				selection = rangeOfEnclosingSymbol;
			} catch (err) {
				if (isCancellationError(err)) {
					return undefined;
				}
				// No enclosing scope found — fall through to scope picker
				return undefined;
			}
			// If scope selector returned an empty or trivial selection, treat as no selection
			if (selection.isEmpty) {
				return undefined;
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
		if (inProgress) {
			const existingReview = inProgress;
			const continueButton = l10n.t('Continue');
			const result = await this.notificationService.showInformationMessage(
				l10n.t('A code review is already in progress. Starting a new review will cancel it.'),
				{ modal: true },
				continueButton
			);
			if (result !== continueButton) {
				return undefined;
			}
			existingReview.cancel();
		}

		return this.notificationService.withProgress({
			location: progressLocation,
			title,
			cancellable: true,
		}, async (_progress, progressToken) => {
			const tokenSource = inProgress = new CancellationTokenSource(
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
				const legacyGroup = typeof group === 'object' && 'group' in group ? group.group : group === 'file' ? 'selection' : group;
				return await review(
					this.instantiationService, this.gitExtensionService, this.workspaceService,
					legacyGroup, editor, progress, tokenSource.token
				);
			}
		} catch (err) {
			this.logService.error(err, 'Error during code review');
			return { type: 'error', reason: err.message, severity: err.severity };
		} finally {
			if (tokenSource === inProgress) {
				inProgress = undefined;
			}
			tokenSource.dispose();
		}
	}

	/**
	 * Handles the review result by showing appropriate notifications.
	 */
	private async handleResult(result: FeedbackResult): Promise<void> {
		return handleReviewResult(result, {
			notificationService: this.notificationService,
			logService: this.logService,
			reviewService: this.reviewService,
		});
	}
}

export type ReviewGroup = 'selection' | 'file' | 'index' | 'workingTree' | 'all' | { group: 'index' | 'workingTree'; file: Uri } | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] };

/**
 * Gets the progress title for a review operation based on the review group type.
 */
export function getReviewTitle(group: ReviewGroup, editor?: TextEditor): string {
	if (group === 'selection') {
		return l10n.t('Reviewing selected code in {0}...', path.posix.basename(editor!.document.uri.path));
	}
	if (group === 'file') {
		return l10n.t('Reviewing {0}...', path.posix.basename(editor!.document.uri.path));
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

/**
 * Runs a code review on file URI pairs and returns structured results.
 * This is the handler for the `github.copilot.chat.codeReview.run` command.
 * It bypasses the comment controller — results are returned directly to the caller.
 */
export async function reviewFileChanges(
	accessor: ServicesAccessor,
	input: CodeReviewInput,
): Promise<CodeReviewResult> {
	const logService = accessor.get(ILogService);
	const authService = accessor.get(IAuthenticationService);
	const capiClientService = accessor.get(ICAPIClientService);
	const fetcherService = accessor.get(IFetcherService);
	const envService = accessor.get(IEnvService);
	const ignoreService = accessor.get(IIgnoreService);
	const workspaceService = accessor.get(IWorkspaceService);
	const fileSystemService = accessor.get(IFileSystemService);
	const customInstructionsService = accessor.get(ICustomInstructionsService);

	const copilotToken = await authService.getCopilotToken();
	if (!copilotToken.isCopilotCodeReviewEnabled) {
		return { type: 'error', reason: 'Code review is not enabled for this account.' };
	}

	const tokenSource = new CancellationTokenSource();
	try {
		const fileInputs = await Promise.all(input.files.map(async file => {
			let baseContent = '';
			if (file.baseUri) {
				const bytes = await fileSystemService.readFile(file.baseUri);
				baseContent = new TextDecoder().decode(bytes);
			}
			return { currentUri: file.currentUri, baseContent };
		}));

		const result = await githubReviewFileUris(
			logService, authService, capiClientService, fetcherService, envService,
			ignoreService, workspaceService, customInstructionsService,
			fileInputs, tokenSource.token,
		);

		if (result.type === 'success') {
			return toCodeReviewResult(result.comments);
		}
		if (result.type === 'error') {
			return { type: 'error', reason: result.reason };
		}
		return { type: 'cancelled' };
	} catch (err) {
		logService.error(err, 'Error during code review command');
		return { type: 'error', reason: err.message };
	} finally {
		tokenSource.dispose();
	}
}