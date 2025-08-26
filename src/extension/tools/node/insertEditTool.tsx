/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { ActionType } from './applyPatch/parser';
import { EditFileResult } from './editFileToolResult';
import { createEditConfirmation } from './editFileToolUtils';
import { sendEditNotebookTelemetry } from './editNotebookTool';
import { assertFileOkForTool } from './toolUtils';

export interface IEditFileParams {
	explanation: string;
	filePath: string;
	code: string;
}

export const InternalEditToolId = 'vscode_editFile_internal';

export class EditFileTool implements ICopilotTool<IEditFileParams> {
	public static toolName = ToolName.EditFile;
	private promptContext?: IBuildPromptContext;
	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@IToolsService protected readonly toolsService: IToolsService,
		@INotebookService protected readonly notebookService: INotebookService,
		@ILanguageDiagnosticsService protected readonly languageDiagnosticsService: ILanguageDiagnosticsService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContentService: IAlternativeNotebookContentService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IEditFileParams>, token: vscode.CancellationToken) {
		const uri = this.promptPathRepresentationService.resolveFilePath(options.input.filePath);
		if (!uri) {
			throw new Error(`Invalid file path`);
		}

		await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));

		const existingDiagnostics = this.languageDiagnosticsService.getDiagnostics(uri);

		// Wait for vscode to do the edit, call the codemapper service, wait for textedits to be applied
		const internalOptions = {
			...options,
			input: {
				...options.input,
				uri
			}
		};
		await this.toolsService.invokeTool(InternalEditToolId, internalOptions, token);

		const isNotebook = this.notebookService.hasSupportedNotebooks(uri);
		const document = isNotebook ?
			await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContentService.getFormat(this.promptContext?.request?.model)) :
			await this.workspaceService.openTextDocumentAndSnapshot(uri);

		if (document instanceof NotebookDocumentSnapshot) {
			sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'insertEdit', uri, this.promptContext?.requestId, options.model ?? this.promptContext?.request?.model);
		}
		// Then fill in the tool result
		return new LanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(
					this.instantiationService,
					EditFileResult,
					{ files: [{ operation: ActionType.UPDATE, uri, isNotebook, existingDiagnostics }], toolName: ToolName.EditFile, requestId: options.chatRequestId, model: options.model },
					// If we are not called with tokenization options, have _some_ fake tokenizer
					// otherwise we end up returning the entire document
					options.tokenizationOptions ?? {
						tokenBudget: 1000,
						countTokens: (t) => Promise.resolve(t.length * 3 / 4)
					},
					token,
				),
			)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IEditFileParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const uri = this.promptPathRepresentationService.resolveFilePath(options.input.filePath);
		return this.instantiationService.invokeFunction(
			createEditConfirmation,
			uri ? [uri] : [],
			() => '```\n' + options.input.code + '\n```',
		);
	}

	async resolveInput(input: IEditFileParams, promptContext: IBuildPromptContext): Promise<IEditFileParams> {
		this.promptContext = promptContext;
		return input;
	}

}

ToolRegistry.registerTool(EditFileTool);
