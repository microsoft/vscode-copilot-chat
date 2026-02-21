/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import type { Ref } from '../../../platform/git/vscode/git';

const DEFAULT_GUIDELINE = 'Perform a detailed code review, ensuring best practices, code consistency, security, and testing if possible.';

/**
 * The scope of what to review.
 */
export type MultiReviewScope =
	| { type: 'uncommitted' }
	| { type: 'branch'; targetBranch: string };

/**
 * Configuration for a single reviewer in the multi-review.
 */
export interface ReviewerConfig {
	readonly modelId: string;
	readonly modelName: string;
	readonly guideline: string;
}

/**
 * Full configuration gathered from the quick-pick UI flow.
 */
export interface MultiReviewConfig {
	readonly scope: MultiReviewScope;
	readonly reviewers: readonly ReviewerConfig[];
}

/**
 * Runs the multi-review quick-pick UI flow to gather configuration.
 * Returns undefined if the user cancels at any step.
 */
export async function showMultiReviewQuickPick(
	gitService: IGitService,
	repoContext: RepoContext | undefined,
): Promise<MultiReviewConfig | undefined> {

	// Step 1: Pick review scope
	const scope = await pickReviewScope(gitService, repoContext);
	if (!scope) {
		return undefined;
	}

	// Step 2: Pick models
	const models = await pickModels();
	if (!models || models.length === 0) {
		return undefined;
	}

	// Step 3: Gather per-model guidelines
	const reviewers = await gatherGuidelines(models);
	if (!reviewers) {
		return undefined;
	}

	return { scope, reviewers };
}

async function pickReviewScope(
	gitService: IGitService,
	repoContext: RepoContext | undefined,
): Promise<MultiReviewScope | undefined> {
	const items: vscode.QuickPickItem[] = [
		{
			label: l10n.t('All uncommitted changes'),
			description: l10n.t('Review staged and unstaged changes against HEAD'),
		},
		{
			label: l10n.t('Current branch against...'),
			description: l10n.t('Compare current branch with another branch'),
		},
	];

	const selected = await vscode.window.showQuickPick(items, {
		title: l10n.t('Multi-Agent Code Review'),
		placeHolder: l10n.t('Select what to review'),
	});

	if (!selected) {
		return undefined;
	}

	if (selected === items[0]) {
		return { type: 'uncommitted' };
	}

	// Branch comparison — show branch picker
	const targetBranch = await pickBranch(gitService, repoContext);
	if (!targetBranch) {
		return undefined;
	}
	return { type: 'branch', targetBranch };
}

async function pickBranch(
	gitService: IGitService,
	repoContext: RepoContext | undefined,
): Promise<string | undefined> {
	if (!repoContext) {
		const branchName = await vscode.window.showInputBox({
			title: l10n.t('Compare against branch'),
			placeHolder: l10n.t('Enter branch name (e.g., main, master)'),
			prompt: l10n.t('Enter the branch to compare against'),
		});
		return branchName || undefined;
	}

	const refs = await gitService.getRefs(repoContext.rootUri, {
		pattern: 'refs/heads/',
		sort: 'committerdate',
	});

	const currentBranch = repoContext.headBranchName;
	const branchItems: vscode.QuickPickItem[] = refs
		.filter((ref: Ref) => ref.type === 0 /* RefType.Head */ && ref.name && ref.name !== currentBranch)
		.map((ref: Ref) => ({
			label: ref.name!,
			description: ref.commit ? ref.commit.substring(0, 7) : undefined,
		}));

	if (branchItems.length === 0) {
		const branchName = await vscode.window.showInputBox({
			title: l10n.t('Compare against branch'),
			placeHolder: l10n.t('Enter branch name (e.g., main, master)'),
			prompt: l10n.t('No other local branches found. Enter a branch name manually.'),
		});
		return branchName || undefined;
	}

	const selected = await vscode.window.showQuickPick(branchItems, {
		title: l10n.t('Compare against branch'),
		placeHolder: l10n.t('Select a branch to compare against'),
	});

	return selected?.label;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
	model: vscode.LanguageModelChat;
}

async function pickModels(): Promise<vscode.LanguageModelChat[] | undefined> {
	const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (allModels.length === 0) {
		vscode.window.showWarningMessage(l10n.t('No chat models available.'));
		return undefined;
	}

	const items: ModelQuickPickItem[] = allModels.map(model => ({
		label: model.name,
		description: model.family,
		model,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		title: l10n.t('Select Reviewer Models'),
		placeHolder: l10n.t('Select one or more models to perform the review'),
		canPickMany: true,
	});

	if (!selected || selected.length === 0) {
		return undefined;
	}

	return selected.map(item => item.model);
}

async function gatherGuidelines(
	models: vscode.LanguageModelChat[]
): Promise<ReviewerConfig[] | undefined> {
	const reviewers: ReviewerConfig[] = [];

	for (const model of models) {
		const guideline = await vscode.window.showInputBox({
			title: l10n.t('Guidelines for {0}', model.name),
			prompt: l10n.t('Enter review guidelines for this model (press Enter to use default)'),
			value: DEFAULT_GUIDELINE,
			placeHolder: DEFAULT_GUIDELINE,
		});

		if (guideline === undefined) {
			// User cancelled
			return undefined;
		}

		reviewers.push({
			modelId: model.id,
			modelName: model.name,
			guideline: guideline || DEFAULT_GUIDELINE,
		});
	}

	return reviewers;
}
