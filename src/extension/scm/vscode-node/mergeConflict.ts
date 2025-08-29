/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeLensProvider } from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { MergeConflictParser } from './mergeConflictParser';

export class MergeConflictCodeLensContribution extends Disposable implements IExtensionContribution, CodeLensProvider {
	readonly id = 'mergeConflictCodeLens';

	constructor(
		@IGitService private readonly gitService: IGitService,
		@IIgnoreService private readonly ignoreService: IIgnoreService,
	) {
		super();

		// Match schemes supported by the merge-conflict extension
		this._register(vscode.languages.registerCodeLensProvider([
			{ scheme: 'file' },
			{ scheme: 'vscode-vfs' },
			{ scheme: 'untitled' },
			{ scheme: 'vscode-userdata' },
		], this));
	}

	async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[] | null> {
		if (token.isCancellationRequested) {
			return null;
		}

		if (await this.ignoreService.isCopilotIgnored(document.uri, token)) {
			return null;
		}

		if (!MergeConflictParser.containsConflict(document)) {
			return null;
		}

		const repository = await this.gitService.getRepository(document.uri);
		if (!repository) {
			return null;
		}

		const result: vscode.CodeLens[] = [];
		const conflicts = MergeConflictParser.scanDocument(document);

		for (const conflict of conflicts) {
			const range = document.lineAt(conflict.range.start.line).range;

			const command = {
				command: 'github.copilot.git.resolveMergeConflict',
				title: vscode.l10n.t("Resolve with Copilot"),
				arguments: [repository.rootUri, document.uri, conflict]
			} satisfies vscode.Command;

			result.push(new vscode.CodeLens(range, command));
		}

		return token.isCancellationRequested ? null : result;
	}
}
