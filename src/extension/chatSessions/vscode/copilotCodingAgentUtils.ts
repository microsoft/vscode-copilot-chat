/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGithubRepoIdFromFetchUrl, GithubRepoId, IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';

export const MAX_PROBLEM_STATEMENT_LENGTH = 30_000 - 50; // 50 character buffer
export const CONTINUE_TRUNCATION = vscode.l10n.t('Continue with truncation');
export const body_suffix = vscode.l10n.t('Created from VS Code via the [GitHub Pull Request](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) extension.');
export const JOBS_API_VERSION = 'v1';
type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: vscode.Uri; llmDetails: string; sessionId: string };
type RemoteAgentErrorResult = { error: string; innerError?: string; state: 'error' };
export type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

/**
 * Truncation utility to ensure the problem statement sent to Copilot API is under the maximum length.
 * Truncation is not ideal. The caller providing the prompt/context should be summarizing so this is a no-op whenever possible.
 *
 * @param prompt The final message submitted by the user
 * @param context Any additional context collected by the caller (chat history, open files, etc...)
 * @returns A complete 'problem statement' string that is under the maximum length, and a flag indicating if truncation occurred
 */
export function truncatePrompt(logService: ILogService, prompt: string, context?: string): { problemStatement: string; isTruncated: boolean } {
	// Prioritize the userPrompt
	// Take the last n characters that fit within the limit
	if (prompt.length >= MAX_PROBLEM_STATEMENT_LENGTH) {
		logService.warn(`Truncation: Prompt length ${prompt.length} exceeds max of ${MAX_PROBLEM_STATEMENT_LENGTH}`);
		prompt = prompt.slice(-MAX_PROBLEM_STATEMENT_LENGTH);
		return { problemStatement: prompt, isTruncated: true };
	}

	if (context && (prompt.length + context.length >= MAX_PROBLEM_STATEMENT_LENGTH)) {
		const availableLength = MAX_PROBLEM_STATEMENT_LENGTH - prompt.length - 2 /* new lines */;
		logService.warn(`Truncation: Combined prompt and context length ${prompt.length + context.length} exceeds max of ${MAX_PROBLEM_STATEMENT_LENGTH}`);
		context = context.slice(-availableLength);
		return {
			problemStatement: prompt + (context ? `\n\n${context}` : ''),
			isTruncated: true
		};
	}

	// No truncation occurred
	return {
		problemStatement: prompt + (context ? `\n\n${context}` : ''),
		isTruncated: false
	};
}

export function extractTitle(prompt: string, context: string | undefined): string | undefined {
	const fromTitle = () => {
		if (!prompt) {
			return;
		}
		if (prompt.length <= 20) {
			return prompt;
		}
		return prompt.substring(0, 20) + '...';
	};
	const titleMatch = context?.match(/TITLE: \s*(.*)/i);
	if (titleMatch && titleMatch[1]) {
		return titleMatch[1].trim();
	}
	return fromTitle();

}

export function formatBodyPlaceholder(title: string | undefined): string {
	return vscode.l10n.t('Coding agent has begun work on **{0}** and will update this pull request as work progresses.', title || vscode.l10n.t('your request'));
}

export async function getRepoId(gitService: IGitService): Promise<GithubRepoId | undefined> {
	let timeout = 5000;
	while (!gitService.isInitialized) {
		await new Promise(resolve => setTimeout(resolve, 100));
		timeout -= 100;
		if (timeout <= 0) {
			break;
		}
	}

	const repo = gitService.activeRepository.get();
	if (repo && repo.remoteFetchUrls?.[0]) {
		return getGithubRepoIdFromFetchUrl(repo.remoteFetchUrls[0]);
	}
}

export namespace SessionIdForPr {

	const prefix = 'pull-session-by-index';

	export function getId(prNumber: number, sessionIndex: number): string {
		return `${prefix}-${prNumber}-${sessionIndex}`;
	}

	export function parse(id: string): { prNumber: number; sessionIndex: number } | undefined {
		const match = id.match(new RegExp(`^${prefix}-(\\d+)-(\\d+)$`));
		if (match) {
			return {
				prNumber: parseInt(match[1], 10),
				sessionIndex: parseInt(match[2], 10)
			};
		}
		return undefined;
	}
}
