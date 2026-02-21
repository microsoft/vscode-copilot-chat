/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { URI } from '../../../util/vs/base/common/uri';
import { MultiReviewConfig, showMultiReviewQuickPick } from './multiReviewUI';

const MAX_DIFF_LENGTH = 80_000;

/**
 * Orchestrates the multi-agent code review flow:
 * 1. Gathers configuration via quick-pick UI
 * 2. Collects diffs based on the selected scope
 * 3. Constructs a multi-reviewer prompt
 * 4. Opens a chat session with the prompt
 */
export class MultiReviewSession {

	constructor(
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
	) { }

	async run(): Promise<void> {
		try {
			const repoContext = this.gitService.repositories[0];
			const config = await showMultiReviewQuickPick(this.gitService, repoContext);
			if (!config) {
				return;
			}

			const diff = await this.gatherDiff(config);
			if (!diff) {
				return;
			}

			const prompt = buildMultiReviewPrompt(config, diff);
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: prompt,
			});

		} catch (err) {
			this.logService.error(err, 'Error during multi-agent code review');
			vscode.window.showErrorMessage(l10n.t('Multi-agent code review failed: {0}', err.message));
		}
	}

	private async gatherDiff(config: MultiReviewConfig): Promise<string | undefined> {
		const repoContext = this.gitService.repositories[0];
		if (!repoContext) {
			vscode.window.showWarningMessage(l10n.t('No Git repository found in the workspace.'));
			return undefined;
		}

		const repoUri = repoContext.rootUri;

		let diff: string | undefined;
		if (config.scope.type === 'uncommitted') {
			diff = await this.getUncommittedDiff(repoUri);
		} else {
			diff = await this.getBranchDiff(repoUri, config.scope.targetBranch);
		}

		if (!diff || diff.trim().length === 0) {
			vscode.window.showInformationMessage(l10n.t('No changes found to review.'));
			return undefined;
		}

		if (diff.length > MAX_DIFF_LENGTH) {
			this.logService.info(`[MultiReview] Diff truncated from ${diff.length} to ${MAX_DIFF_LENGTH} characters.`);
			diff = diff.substring(0, MAX_DIFF_LENGTH) + '\n\n... (diff truncated due to size)';
		}

		return diff;
	}

	private async getUncommittedDiff(repoUri: URI): Promise<string | undefined> {
		// Get both staged and unstaged changes as a combined diff
		const stagedDiff = await this.gitService.diffBetweenPatch(repoUri, 'HEAD', '');
		const unstagedDiff = await this.gitService.diffBetweenPatch(repoUri, '', 'HEAD');

		// diffBetweenPatch with empty ref might not work as expected on all git versions.
		// Fall back to diffBetween HEAD vs working tree via the repository API.
		if (!stagedDiff && !unstagedDiff) {
			// Try HEAD vs working tree
			return this.gitService.diffBetweenPatch(repoUri, 'HEAD', 'HEAD');
		}

		const parts: string[] = [];
		if (stagedDiff) {
			parts.push('## Staged Changes\n\n' + stagedDiff);
		}
		if (unstagedDiff) {
			parts.push('## Unstaged Changes\n\n' + unstagedDiff);
		}
		return parts.join('\n\n');
	}

	private async getBranchDiff(repoUri: URI, targetBranch: string): Promise<string | undefined> {
		const headBranch = this.gitService.repositories[0]?.headBranchName;
		if (!headBranch) {
			vscode.window.showWarningMessage(l10n.t('Cannot determine current branch.'));
			return undefined;
		}

		const mergeBase = await this.gitService.getMergeBase(repoUri, targetBranch, headBranch);
		const baseRef = mergeBase ?? targetBranch;

		return this.gitService.diffBetweenPatch(repoUri, baseRef, headBranch);
	}
}

/**
 * Builds the multi-reviewer prompt to send to the chat panel.
 */
export function buildMultiReviewPrompt(config: MultiReviewConfig, diff: string): string {
	const lines: string[] = [];

	lines.push('# Multi-Agent Code Review');
	lines.push('');
	lines.push('You are coordinating a multi-perspective code review. For each reviewer below, provide a thorough, independent review section from that reviewer\'s perspective and guidelines.');
	lines.push('');

	// Scope description
	if (config.scope.type === 'uncommitted') {
		lines.push('**Scope**: All uncommitted changes (staged and unstaged)');
	} else {
		lines.push(`**Scope**: Current branch compared against \`${config.scope.targetBranch}\``);
	}
	lines.push('');

	// Reviewers section
	lines.push('## Reviewers');
	lines.push('');
	for (let i = 0; i < config.reviewers.length; i++) {
		const reviewer = config.reviewers[i];
		lines.push(`${i + 1}. **${reviewer.modelName}** — Guidelines: "${reviewer.guideline}"`);
	}
	lines.push('');

	// Changes section
	lines.push('## Changes to Review');
	lines.push('');
	lines.push('```diff');
	lines.push(diff);
	lines.push('```');
	lines.push('');

	// Instructions
	lines.push('## Instructions');
	lines.push('');
	lines.push('For each reviewer listed above, produce a clearly labeled section containing:');
	lines.push('- **Reviewer Name and Model**: The reviewer identity');
	lines.push('- **Findings**: Specific issues found, referencing file names and line numbers from the diff');
	lines.push('- **Severity**: Critical / Major / Minor / Suggestion for each finding');
	lines.push('- **Recommendations**: Actionable improvement suggestions');
	lines.push('');
	lines.push('After all individual reviews, provide a **Consolidated Summary** that:');
	lines.push('- Highlights findings mentioned by multiple reviewers');
	lines.push('- Prioritizes the most critical issues');
	lines.push('- Notes any conflicting recommendations between reviewers');

	return lines.join('\n');
}
