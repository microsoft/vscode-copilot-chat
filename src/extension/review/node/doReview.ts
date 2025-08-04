/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextEditor } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
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
import { l10n } from '../../../vscodeTypes';
import { FeedbackGenerator, FeedbackResult } from '../../prompt/node/feedbackGenerator';
import { CurrentChange, CurrentChangeInput } from '../../prompts/node/feedback/currentChange';
import { githubReview } from './githubReviewAgent';

function combineCancellationTokens(token1: CancellationToken, token2: CancellationToken): CancellationToken {
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
const scmProgressKey = 'github.copilot.chat.review.sourceControlProgress';
export async function doReview(
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
	group: 'selection' | 'index' | 'workingTree' | 'all' | { repositoryRoot: string; commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] },
	progressLocation: ProgressLocation,
	cancellationToken?: CancellationToken
): Promise<FeedbackResult | undefined> {
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
				: l10n.t('Reviewing changes...');
	return notificationService.withProgress({
		location: progressLocation,
		title,
		cancellable: true,
	}, async (_progress, progressToken) => {
		if (inProgress) {
			inProgress.cancel();
		}
		const tokenSource = inProgress = new CancellationTokenSource(cancellationToken ? combineCancellationTokens(cancellationToken, progressToken) : progressToken);
		if (progressLocation === ProgressLocation.SourceControl) {
			await commandService.executeCommand('setContext', scmProgressKey, true);
		}
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
			const canUseGitHubAgent = (group === 'index' || group === 'workingTree' || group === 'all' || typeof group === 'object') && copilotToken.isCopilotCodeReviewEnabled;
			result = canUseGitHubAgent ? await githubReview(logService, gitExtensionService, authService, capiClientService, domainService, fetcherService, envService, ignoreService, workspaceService, group, progress, tokenSource.token) : await review(instantiationService, gitExtensionService, workspaceService, group, editor, progress, tokenSource.token);
		} catch (err) {
			result = { type: 'error', reason: err.message, severity: err.severity };
		} finally {
			if (tokenSource === inProgress) {
				inProgress = undefined;
			}
			tokenSource.dispose();
			if (progressLocation === ProgressLocation.SourceControl) {
				await commandService.executeCommand('setContext', scmProgressKey, undefined);
			}
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

export async function cancelReview(progressLocation: ProgressLocation, commandService: IRunCommandExecutionService) {
	if (inProgress) {
		inProgress.cancel();
	}
	if (progressLocation === ProgressLocation.SourceControl) {
		await commandService.executeCommand('setContext', scmProgressKey, undefined);
	}
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