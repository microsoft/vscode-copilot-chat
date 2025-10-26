/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * URI schemes for PR content
 */
export namespace PRSchemes {
	export const PR_BASE = 'copilot-pr-base'; // For base commit content
	export const PR_HEAD = 'copilot-pr-head'; // For head commit content
}

/**
 * Parameters encoded in PR content URIs
 */
export interface PRContentUriParams {
	owner: string;
	repo: string;
	prNumber: number;
	fileName: string;
	commitSha: string;
	isBase: boolean; // true for left side, false for right side
	previousFileName?: string; // for renames
}

/**
 * Create a URI for PR file content
 */
export function toPRContentUri(
	fileName: string,
	params: Omit<PRContentUriParams, 'fileName'>
): vscode.Uri {
	const scheme = params.isBase ? PRSchemes.PR_BASE : PRSchemes.PR_HEAD;
	return vscode.Uri.from({
		scheme,
		path: `/${fileName}`,
		query: JSON.stringify({ ...params, fileName })
	});
}

/**
 * Parse parameters from a PR content URI
 */
export function fromPRContentUri(uri: vscode.Uri): PRContentUriParams | undefined {
	if (uri.scheme !== PRSchemes.PR_BASE && uri.scheme !== PRSchemes.PR_HEAD) {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as PRContentUriParams;
	} catch (e) {
		return undefined;
	}
}

/**
 * TextDocumentContentProvider for PR content that fetches file content from GitHub
 */
export class PRContentProvider extends Disposable implements vscode.TextDocumentContentProvider {
	private static readonly ID = 'PRContentProvider';
	private _onDidChange = this._register(new vscode.EventEmitter<vscode.Uri>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IOctoKitService private readonly _octoKitService: IOctoKitService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Register text document content providers for both base and head schemes
		this._register(
			vscode.workspace.registerTextDocumentContentProvider(
				PRSchemes.PR_BASE,
				this
			)
		);
		this._register(
			vscode.workspace.registerTextDocumentContentProvider(
				PRSchemes.PR_HEAD,
				this
			)
		);
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = fromPRContentUri(uri);
		if (!params) {
			this.logService.error(`[${PRContentProvider.ID}] Invalid PR content URI: ${uri.toString()}`);
			return '';
		}

		try {
			this.logService.trace(
				`[${PRContentProvider.ID}] Fetching ${params.isBase ? 'base' : 'head'} content for ${params.fileName} ` +
				`from ${params.owner}/${params.repo}#${params.prNumber} at ${params.commitSha}`
			);

			// Fetch file content from GitHub
			const content = await this._octoKitService.getFileContent(
				params.owner,
				params.repo,
				params.commitSha,
				params.fileName
			);

			return content;
		} catch (error) {
			this.logService.error(
				`[${PRContentProvider.ID}] Failed to fetch PR file content: ${error instanceof Error ? error.message : String(error)}`
			);
			// Return empty content instead of throwing to avoid breaking the diff view
			return '';
		}
	}
}
