/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { Diff, IGitDiffService } from '../../../platform/git/common/gitDiffService';
import { IGitService } from '../../../platform/git/common/gitService';
import { Change } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { GitChanges } from '../../prompts/node/git/gitChanges';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation, formatUriForFileWidget } from './toolUtils';

interface IGetScmChangesToolParams {
	repositoryPath?: string;
	sourceControlState?: ('unstaged' | 'staged' | 'merge-conflicts')[];
}

class GetScmChangesTool implements ICopilotTool<IGetScmChangesToolParams> {

	public static readonly toolName = ToolName.GetScmChanges;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IGitService private readonly gitService: IGitService,
		@IGitDiffService private readonly gitDiffService: IGitDiffService,
		@ILogService private readonly logService: ILogService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IGetScmChangesToolParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult | null | undefined> {
		checkCancellation(token);
		await this.gitService.initialize();

		this.logService.trace(`[GetScmChangesTool][invoke] Options: ${JSON.stringify(options)}`);

		const diffs: Diff[] = [];
		const changedFiles: Change[] = [];

		const uri = options.input.repositoryPath
			? this.promptPathRepresentationService.resolveFilePath(options.input.repositoryPath)
			: undefined;

		let repository = uri ? await this.gitService.getRepository(uri) : undefined;
		repository = repository ?? this.gitService.activeRepository.get();

		if (!repository) {
			this.logService.warn(`[GetScmChangesTool][invoke] Unable to resolve the repository using repositoryPath: ${options.input.repositoryPath}`);
			this.logService.warn(`[GetScmChangesTool][invoke] Unable to resolve the active repository: ${this.gitService.activeRepository.get()?.rootUri.toString()}`);

			return new LanguageModelToolResult([new LanguageModelTextPart('The workspace does not contain a git repository')]);
		}

		this.logService.trace(`[GetScmChangesTool][invoke] Uri: ${uri?.toString()}`);
		this.logService.trace(`[GetScmChangesTool][invoke] Repository: ${repository.rootUri.toString()}`);

		const changes = repository?.changes;
		if (changes) {
			try {
				if (options.input.sourceControlState) {
					for (const state of options.input.sourceControlState) {
						switch (state) {
							case 'staged':
								changedFiles.push(...changes.indexChanges);
								break;
							case 'unstaged':
								changedFiles.push(
									...changes.workingTree,
									...changes.untrackedChanges);
								break;
							case 'merge-conflicts':
								changedFiles.push(...changes.mergeChanges);
								break;
						}
					}
				} else {
					changedFiles.push(
						...changes.workingTree,
						...changes.indexChanges,
						...changes.mergeChanges,
						...changes.untrackedChanges);
				}

				diffs.push(...await this.gitDiffService.getChangeDiffs(repository.rootUri, changedFiles));
			} catch { }
		} else {
			this.logService.warn(`[GetScmChangesTool][invoke] Unable to retrieve changes because there is no active repository`);
		}

		checkCancellation(token);

		return new LanguageModelToolResult(
			[diffs.length
				? new LanguageModelPromptTsxPart(await renderPromptElementJSON(this.instantiationService, GitChanges, { diffs }, options.tokenizationOptions, token))
				: new LanguageModelTextPart('No changed files found')]
		);
	}

	prepareInvocation?(options: vscode.LanguageModelToolInvocationPrepareOptions<IGetScmChangesToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		const uri = options.input.repositoryPath
			? this.promptPathRepresentationService.resolveFilePath(options.input.repositoryPath)
			: undefined;

		this.logService.trace(`[GetScmChangesTool][prepareInvocation] Options: ${JSON.stringify(options)}`);
		this.logService.trace(`[GetScmChangesTool][prepareInvocation] Uri: ${uri?.toString()}`);

		return uri
			? {
				invocationMessage: new MarkdownString(l10n.t`Reading changed files in ${formatUriForFileWidget(uri)}`),
				pastTenseMessage: new MarkdownString(l10n.t`Read changed files in ${formatUriForFileWidget(uri)}`),
			}
			: {
				invocationMessage: new MarkdownString(l10n.t`Reading changed files in the active git repository`),
				pastTenseMessage: new MarkdownString(l10n.t`Read changed files in the active git repository`),
			};
	}

	async provideInput(): Promise<IGetScmChangesToolParams | undefined> {
		await this.gitService.initialize();

		this.logService.trace(`[GetScmChangesTool][provideInput] Active repository: ${this.gitService.activeRepository.get()?.rootUri.toString()}`);

		return Promise.resolve({
			repositoryPath: this.gitService.activeRepository.get()?.rootUri.toString(),
			sourceControlState: ['unstaged', 'staged'],
		});
	}
}

ToolRegistry.registerTool(GetScmChangesTool);
