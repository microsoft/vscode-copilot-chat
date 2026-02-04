/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { TextEditor, Uri } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
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
		@IRunCommandExecutionService private readonly commandService: IRunCommandExecutionService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
	) { }

	async review(
		group: 'selection' | 'index' | 'workingTree' | 'all' | { group: 'index' | 'workingTree'; file: Uri } | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] },
		progressLocation: ProgressLocation,
		cancellationToken?: CancellationToken
	): Promise<FeedbackResult | undefined> {
		return doReview(
			this.scopeSelector,
			this.instantiationService,
			this.reviewService,
			this.authService,
			this.logService,
			this.gitExtensionService,
			this.capiClientService,
			this.domainService,
			this.fetcherService,
			this.envService,
			this.ignoreService,
			this.tabsAndEditorsService,
			this.workspaceService,
			this.commandService,
			this.notificationService,
			this.customInstructionsService,
			group,
			progressLocation,
			cancellationToken
		);
	}
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

let inProgress: CancellationTokenSource | undefined;
async function doReview(
	scopeSelector: IScopeSelector,
	instantiationService: IInstantiationService,
	reviewService: IReviewService,
	authService: IAuthenticationService,
	logService: ILogService,
	gitExtensionService: IGitExtensionService,
	capiClientService: ICAPIClientService,
	domainService: IDomainService,
	fetcherService: IFetcherService,
	envService: IEnvService,
	ignoreService: IIgnoreService,
	tabsAndEditorsService: ITabsAndEditorsService,
	workspaceService: IWorkspaceService,
	commandService: IRunCommandExecutionService,
	notificationService: INotificationService,
	customInstructionsService: ICustomInstructionsService,
	group: 'selection' | 'index' | 'workingTree' | 'all' | { group: 'index' | 'workingTree'; file: Uri } | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] },
	progressLocation: ProgressLocation,
	cancellationToken?: CancellationToken
): Promise<FeedbackResult | undefined> {

	if (authService.copilotToken?.isNoAuthUser) {
		// Review requires a logged in user, so best we can do is prompt them to sign in
		await notificationService.showQuotaExceededDialog({ isNoAuthUser: true });
		return undefined;
	}

	const editor = tabsAndEditorsService.activeTextEditor;
	let selection = editor?.selection;
	if (group === 'selection') {
		if (!editor) {
			return;
		}
		if (!selection || selection.isEmpty) {
			try {
				const rangeOfEnclosingSymbol = await scopeSelector.selectEnclosingScope(editor, { reason: l10n.t('Select an enclosing range to review'), includeBlocks: true });
				if (!rangeOfEnclosingSymbol) {
					return;
				}
				selection = rangeOfEnclosingSymbol;
			} catch (err) {
				if (isCancellationError(err)) {
					return;
				}
			}
		}
	}
	const title = group === 'selection' ? l10n.t('Reviewing selected code in {0}...', path.posix.basename(editor!.document.uri.path))
		: group === 'index' ? l10n.t('Reviewing staged changes...')
			: group === 'workingTree' ? l10n.t('Reviewing unstaged changes...')
				: group === 'all' ? l10n.t('Reviewing uncommitted changes...')
					: 'repositoryRoot' in group ? l10n.t('Reviewing changes...')
						: group.group === 'index' ? l10n.t('Reviewing staged changes in {0}...', path.posix.basename(group.file.path))
							: l10n.t('Reviewing unstaged changes in {0}...', path.posix.basename(group.file.path));
	return notificationService.withProgress({
		location: progressLocation,
		title,
		cancellable: true,
	}, async (_progress, progressToken) => {
		if (inProgress) {
			inProgress.cancel();
		}
		const tokenSource = inProgress = new CancellationTokenSource(cancellationToken ? combineCancellationTokens(cancellationToken, progressToken) : progressToken);
		reviewService.removeReviewComments(reviewService.getReviewComments());
		const progress: Progress<ReviewComment[]> = {
			report: comments => {
				if (!tokenSource.token.isCancellationRequested) {
					reviewService.addReviewComments(comments);
				}
			}
		};
		let result: FeedbackResult;
		try {
			const copilotToken = await authService.getCopilotToken();
			const canUseGitHubAgent = copilotToken.isCopilotCodeReviewEnabled;
			result = canUseGitHubAgent ? await githubReview(logService, gitExtensionService, authService, capiClientService, domainService, fetcherService, envService, ignoreService, workspaceService, customInstructionsService, group, editor, progress, tokenSource.token) : await review(instantiationService, gitExtensionService, workspaceService, typeof group === 'object' && 'group' in group ? group.group : group, editor, progress, tokenSource.token);
		} catch (err) {
			logService.error(err, 'Error during code review');
			result = { type: 'error', reason: err.message, severity: err.severity };
		} finally {
			if (tokenSource === inProgress) {
				inProgress = undefined;
			}
			tokenSource.dispose();
		}
		if (tokenSource.token.isCancellationRequested) {
			return { type: 'cancelled' };
		}
		if (result.type === 'error') {
			const showLog = l10n.t('Show Log');
			const res = await (result.severity === 'info' ?
				notificationService.showInformationMessage(result.reason, { modal: true }) :
				notificationService.showInformationMessage(l10n.t('Code review generation failed.'), { modal: true, detail: result.reason }, showLog)
			);
			if (res === showLog) {
				logService.show();
			}
		} else if (result.type === 'success' && result.comments.length === 0) {
			if (result.excludedComments?.length) {
				const show = l10n.t('Show Skipped');
				const res = await notificationService.showInformationMessage(l10n.t('Reviewing your code did not provide any feedback.'), { modal: true, detail: l10n.t('{0} comments were skipped due to low confidence.', result.excludedComments.length) }, show);
				if (res === show) {
					reviewService.addReviewComments(result.excludedComments);
				}
			} else {
				await notificationService.showInformationMessage(l10n.t('Reviewing your code did not provide any feedback.'), { modal: true, detail: result.reason || l10n.t('Copilot only keeps its highest confidence comments to reduce noise and keep you focused.') });
			}
		}
		return result;
	});
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