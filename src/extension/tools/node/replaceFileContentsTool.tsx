/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { IAlternativeNotebookContentEditGenerator, NotebookEditGenrationSource } from '../../../platform/notebook/common/alternativeContentEditGenerator';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { extname } from '../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { processFullRewrite, processFullRewriteNotebook } from '../../prompts/node/codeMapper/codeMapper';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { ActionType } from './applyPatch/parser';
import { EditFileResult } from './editFileToolResult';
import { canExistingFileBeEdited, createEditConfirmation, formatDiffAsUnified } from './editFileToolUtils';
import { assertFileNotContentExcluded, resolveToolInputPath } from './toolUtils';

export interface IReplaceFileContentsParams {
	filePath: string;
	newContent: string;
	explanation: string;
}

export class ReplaceFileContentsTool implements ICopilotTool<IReplaceFileContentsParams> {
	public static toolName = ToolName.ReplaceFileContents;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@INotebookService protected readonly notebookService: INotebookService,
		@IAlternativeNotebookContentService protected readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IAlternativeNotebookContentEditGenerator protected readonly alternativeNotebookEditGenerator: IAlternativeNotebookContentEditGenerator,
		@IFileSystemService protected readonly fileSystemService: IFileSystemService,
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IEndpointProvider protected readonly endpointProvider: IEndpointProvider,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IReplaceFileContentsParams>, token: vscode.CancellationToken) {
		const uri = this.promptPathRepresentationService.resolveFilePath(options.input.filePath);
		if (!uri) {
			throw new Error('Invalid file path');
		}

		await this.instantiationService.invokeFunction(accessor => assertFileNotContentExcluded(accessor, uri));

		if (!this._promptContext?.stream) {
			throw new Error('Invalid stream');
		}

		// Validate parameters
		if (!options.input.filePath || options.input.newContent === undefined) {
			throw new Error('Invalid input: filePath and newContent are required');
		}

		// Check that the file exists - this tool is for replacing existing files
		const exists = await this.instantiationService.invokeFunction(canExistingFileBeEdited, uri);
		if (!exists) {
			throw new Error(`File does not exist: ${options.input.filePath}. Use the ${ToolName.CreateFile} tool to create new files.`);
		}

		const hasSupportedNotebooks = this.notebookService.hasSupportedNotebooks(uri);
		const fileExtension = extname(uri);
		const modelId = options.model && (await this.endpointProvider.getChatEndpoint(options.model)).model;

		let doc: NotebookDocumentSnapshot | TextDocumentSnapshot;
		if (hasSupportedNotebooks) {
			doc = await this.workspaceService.openNotebookDocumentAndSnapshot(uri, this.alternativeNotebookContent.getFormat(this._promptContext?.request?.model));
		} else {
			doc = await this.workspaceService.openTextDocumentAndSnapshot(uri);
		}

		const oldLength = doc.getText().length;

		if (hasSupportedNotebooks) {
			// For notebooks, use processFullRewriteNotebook
			await processFullRewriteNotebook(
				(doc as NotebookDocumentSnapshot).document,
				options.input.newContent,
				this._promptContext.stream,
				this.alternativeNotebookEditGenerator,
				{
					source: NotebookEditGenrationSource.stringReplace,
					requestId: options.chatRequestId,
					model: options.model ? this.endpointProvider.getChatEndpoint(options.model).then(m => m.model) : undefined
				},
				token
			);
			this._promptContext.stream.notebookEdit(uri, true);
			this.sendTelemetry(options.chatRequestId, modelId, fileExtension, oldLength, options.input.newContent.length, true);

			return new LanguageModelToolResult([
				new LanguageModelTextPart(
					`Replaced contents of notebook ${this.promptPathRepresentationService.getFilePath(uri)}`,
				)
			]);
		} else {
			// For regular files, use processFullRewrite
			await processFullRewrite(uri, doc as TextDocumentSnapshot, options.input.newContent, this._promptContext.stream, token, []);
			this._promptContext.stream.textEdit(uri, true);
			this.sendTelemetry(options.chatRequestId, modelId, fileExtension, oldLength, options.input.newContent.length, false);

			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(
						this.instantiationService,
						EditFileResult,
						{
							files: [{ operation: ActionType.UPDATE, uri, isNotebook: false }],
							diagnosticsTimeout: 2000,
							toolName: ToolName.ReplaceFileContents,
							requestId: options.chatRequestId,
							model: options.model
						},
						options.tokenizationOptions ?? {
							tokenBudget: 1000,
							countTokens: (t) => Promise.resolve(t.length * 3 / 4)
						},
						token,
					),
				)
			]);
		}
	}

	async resolveInput(input: IReplaceFileContentsParams, promptContext: IBuildPromptContext): Promise<IReplaceFileContentsParams> {
		this._promptContext = promptContext;
		return input;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IReplaceFileContentsParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		const newContent = options.input.newContent || '';

		// Get current file content for diff preview
		let oldContent = '';
		try {
			const doc = await this.workspaceService.openTextDocumentAndSnapshot(uri);
			oldContent = doc.getText();
		} catch {
			// File might not exist yet - but this tool requires existing files
		}

		const confirmation = await this.instantiationService.invokeFunction(
			createEditConfirmation,
			[uri],
			async () => this.instantiationService.invokeFunction(
				formatDiffAsUnified,
				uri,
				oldContent,
				newContent
			),
		);

		return {
			...confirmation,
			presentation: undefined,
			invocationMessage: new MarkdownString(l10n.t`Replacing contents of ${formatUriForFileWidget(uri)}`),
			pastTenseMessage: new MarkdownString(l10n.t`Replaced contents of ${formatUriForFileWidget(uri)}`)
		};
	}

	private sendTelemetry(requestId: string | undefined, model: string | undefined, fileExtension: string, oldLength: number, newLength: number, isNotebook: boolean) {
		/* __GDPR__
			"replaceFileContentsToolInvoked" : {
				"owner": "roblourens",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"fileExtension": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The file extension of the file being replaced" },
				"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the file is a notebook" },
				"oldLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The length of the original file content" },
				"newLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The length of the new file content" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('replaceFileContentsToolInvoked', {
			requestId,
			model,
			fileExtension,
			isNotebook: String(isNotebook)
		}, {
			oldLength,
			newLength
		});
	}
}

ToolRegistry.registerTool(ReplaceFileContentsTool);
