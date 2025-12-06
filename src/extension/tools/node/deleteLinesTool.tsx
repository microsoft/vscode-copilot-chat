/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { extname } from '../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import {
	LanguageModelPromptTsxPart,
	LanguageModelToolResult,
	MarkdownString,
	Range,
	TextEdit,
} from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { ActionType } from './applyPatch/parser';
import { EditFileResult } from './editFileToolResult';
import {
	canExistingFileBeEdited,
	createEditConfirmation,
	formatDiffAsUnified,
} from './editFileToolUtils';
import {
	assertFileNotContentExcluded,
	resolveToolInputPath,
} from './toolUtils';

export interface IDeleteLinesParams {
	filePath: string;
	startLine: number;
	endLine: number;
}

export class DeleteLinesTool implements ICopilotTool<IDeleteLinesParams> {
	public static toolName = ToolName.DeleteLines;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IPromptPathRepresentationService
		protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService
		protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService
		protected readonly workspaceService: IWorkspaceService,
		@IFileSystemService
		protected readonly fileSystemService: IFileSystemService,
		@ITelemetryService
		protected readonly telemetryService: ITelemetryService,
		@IEndpointProvider
		protected readonly endpointProvider: IEndpointProvider,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IDeleteLinesParams>,
		token: vscode.CancellationToken,
	) {
		const uri = this.promptPathRepresentationService.resolveFilePath(
			options.input.filePath,
		);
		if (!uri) {
			throw new Error('Invalid file path');
		}

		await this.instantiationService.invokeFunction((accessor) =>
			assertFileNotContentExcluded(accessor, uri),
		);

		if (!this._promptContext?.stream) {
			throw new Error('Invalid stream');
		}

		// Validate parameters
		if (
			!options.input.filePath ||
			options.input.startLine === undefined ||
			options.input.endLine === undefined
		) {
			throw new Error(
				'Invalid input: filePath, startLine, and endLine are required',
			);
		}

		const startLine = options.input.startLine;
		const endLine = options.input.endLine;

		if (startLine < 1) {
			throw new Error('startLine must be at least 1 (1-indexed)');
		}

		if (endLine < startLine) {
			throw new Error(
				`endLine (${endLine}) must be greater than or equal to startLine (${startLine})`,
			);
		}

		// Check that the file exists
		const exists = await this.instantiationService.invokeFunction(
			canExistingFileBeEdited,
			uri,
		);
		if (!exists) {
			throw new Error(`File does not exist: ${options.input.filePath}.`);
		}

		const doc =
			await this.workspaceService.openTextDocumentAndSnapshot(uri);
		const lines = doc.getText().split('\n');
		const totalLines = lines.length;

		// Validate line numbers are within bounds
		if (startLine > totalLines) {
			throw new Error(
				`startLine ${startLine} is out of range. File has ${totalLines} lines.`,
			);
		}

		if (endLine > totalLines) {
			throw new Error(
				`endLine ${endLine} is out of range. File has ${totalLines} lines.`,
			);
		}

		const fileExtension = extname(uri);
		const modelId =
			options.model &&
			(await this.endpointProvider.getChatEndpoint(options.model)).model;

		// Create the deletion edit
		// Convert 1-indexed to 0-indexed
		const startLineIndex = startLine - 1;
		const endLineIndex = endLine - 1;

		// Calculate the range to delete
		let deleteRange: Range;
		if (endLineIndex === totalLines - 1) {
			// Deleting to end of file
			if (startLineIndex === 0) {
				// Deleting entire file
				deleteRange = new Range(
					0,
					0,
					totalLines - 1,
					lines[totalLines - 1].length,
				);
			} else {
				// Deleting from startLine to end - also remove the preceding newline
				deleteRange = new Range(
					startLineIndex - 1,
					lines[startLineIndex - 1].length,
					totalLines - 1,
					lines[totalLines - 1].length,
				);
			}
		} else {
			// Deleting in the middle - include the trailing newline
			deleteRange = new Range(startLineIndex, 0, endLineIndex + 1, 0);
		}

		const edit = new TextEdit(deleteRange, '');
		this._promptContext.stream.textEdit(uri, [edit]);

		const linesDeleted = endLine - startLine + 1;
		this.sendTelemetry(
			options.chatRequestId,
			modelId,
			fileExtension,
			linesDeleted,
		);

		return new LanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(
					this.instantiationService,
					EditFileResult,
					{
						files: [
							{
								operation: ActionType.UPDATE,
								uri,
								isNotebook: false,
							},
						],
						diagnosticsTimeout: 2000,
						toolName: ToolName.DeleteLines,
						requestId: options.chatRequestId,
						model: options.model,
					},
					options.tokenizationOptions ?? {
						tokenBudget: 1000,
						countTokens: (t) => Promise.resolve((t.length * 3) / 4),
					},
					token,
				),
			),
		]);
	}

	async resolveInput(
		input: IDeleteLinesParams,
		promptContext: IBuildPromptContext,
	): Promise<IDeleteLinesParams> {
		this._promptContext = promptContext;
		return input;
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IDeleteLinesParams>,
		token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const uri = resolveToolInputPath(
			options.input.filePath,
			this.promptPathRepresentationService,
		);
		const startLine = options.input.startLine;
		const endLine = options.input.endLine;

		// Get current file content for diff preview
		let oldContent = '';
		let newContent = '';
		try {
			const doc =
				await this.workspaceService.openTextDocumentAndSnapshot(uri);
			oldContent = doc.getText();
			const lines = oldContent.split('\n');

			// Calculate what the file will look like after deletion
			const startLineIndex = startLine - 1;
			const endLineIndex = endLine - 1;

			const before = lines.slice(0, startLineIndex);
			const after = lines.slice(endLineIndex + 1);
			newContent = [...before, ...after].join('\n');
		} catch {
			// File might not exist
		}

		const confirmation = await this.instantiationService.invokeFunction(
			createEditConfirmation,
			[uri],
			async () =>
				this.instantiationService.invokeFunction(
					formatDiffAsUnified,
					uri,
					oldContent,
					newContent,
				),
		);

		const lineText =
			startLine === endLine
				? `line ${startLine}`
				: `lines ${startLine}-${endLine}`;
		return {
			...confirmation,
			presentation: undefined,
			invocationMessage: new MarkdownString(
				l10n.t`Deleting ${lineText} from ${formatUriForFileWidget(uri)}`,
			),
			pastTenseMessage: new MarkdownString(
				l10n.t`Deleted ${lineText} from ${formatUriForFileWidget(uri)}`,
			),
		};
	}

	private sendTelemetry(
		requestId: string | undefined,
		model: string | undefined,
		fileExtension: string,
		linesDeleted: number,
	) {
		/* __GDPR__
			"deleteLinesToolInvoked" : {
				"owner": "roblourens",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"fileExtension": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The file extension of the file being edited" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'deleteLinesToolInvoked',
			{
				requestId,
				model,
				fileExtension,
			},
			{
				linesDeleted,
			},
		);
	}
}

ToolRegistry.registerTool(DeleteLinesTool);
