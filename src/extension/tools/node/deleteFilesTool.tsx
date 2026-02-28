/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { ActionType } from './applyPatch/parser';
import { EditFileResult } from './editFileToolResult';
import { createEditConfirmation, getDisallowedEditUriError } from './editFileToolUtils';
import { resolveToolInputPath } from './toolUtils';

export interface IDeleteFilesParams {
	explanation: string;
	filePaths: string[];
}

export class DeleteFilesTool implements ICopilotTool<IDeleteFilesParams> {
	public static toolName = ToolName.DeleteFiles;

	private _promptContext?: IBuildPromptContext;

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) { }

	async resolveInput(input: IDeleteFilesParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDeleteFilesParams> {
		this._promptContext = promptContext;
		return input;
	}

	async handleToolStream(options: vscode.LanguageModelToolInvocationStreamOptions<IDeleteFilesParams>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolStreamResult> {
		const partialInput = options.rawInput as Partial<IDeleteFilesParams> | undefined;

		let invocationMessage: MarkdownString;
		if (partialInput && typeof partialInput === 'object' && partialInput.filePaths?.length) {
			const fileCount = partialInput.filePaths.length;
			const fileList = partialInput.filePaths.map(p => resolveToolInputPath(p, this.promptPathRepresentationService));
			const fileRefs = fileList.map(uri => formatUriForFileWidget(uri)).join(', ');
			invocationMessage = new MarkdownString(l10n.t(`Deleting {0} file(s): {1}`, fileCount, fileRefs));
		} else {
			invocationMessage = new MarkdownString(l10n.t(`Deleting files`));
		}

		return { invocationMessage };
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDeleteFilesParams>, token: vscode.CancellationToken) {
		const uris: vscode.Uri[] = [];
		for (const filePath of options.input.filePaths) {
			const uri = this.promptPathRepresentationService.resolveFilePath(filePath);
			if (uri) {
				uris.push(uri);
			}
		}

		if (uris.length === 0) {
			throw new Error(l10n.t(`No valid file paths provided`));
		}

		for (const uri of uris) {
			const disallowedUriError = getDisallowedEditUriError(uri, this._promptContext?.allowedEditUris, this.promptPathRepresentationService);
			if (disallowedUriError) {
				const result = new ExtendedLanguageModelToolResult([
					new LanguageModelTextPart(disallowedUriError),
				]);
				result.hasError = true;
				return result;
			}
		}

		if (!this._promptContext?.stream) {
			throw new Error('Invalid stream');
		}

		this._promptContext.stream.workspaceEdit(uris.map(uri => ({ oldResource: uri })));

		return new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(
					this.instantiationService,
					EditFileResult,
					{ files: uris.map(uri => ({ operation: ActionType.DELETE, uri, isNotebook: false })), toolName: ToolName.DeleteFiles, requestId: options.chatRequestId, model: options.model },
					options.tokenizationOptions ?? { tokenBudget: 1000, countTokens: (t) => Promise.resolve(t.length * 3 / 4) },
					token,
				),
			),
			new LanguageModelTextPart(l10n.t(`Deleted {0} file(s): {1}`, uris.length, options.input.filePaths.join(', ')))
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDeleteFilesParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const uris = options.input.filePaths
			.map(p => resolveToolInputPath(p, this.promptPathRepresentationService));

		return this.instantiationService.invokeFunction(
			createEditConfirmation,
			uris,
			this._promptContext?.allowedEditUris,
			async (urisNeedingConfirmation) => l10n.t('Delete {0} file(s)', urisNeedingConfirmation.length),
			options.forceConfirmationReason
		);
	}
}

ToolRegistry.registerTool(DeleteFilesTool);
