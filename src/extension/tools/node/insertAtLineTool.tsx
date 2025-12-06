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

export interface IInsertAtLineParams {
	filePath: string;
	line: number;
	content: string;
	position?: 'before' | 'after';
}

export class InsertAtLineTool implements ICopilotTool<IInsertAtLineParams> {
	public static toolName = ToolName.InsertAtLine;

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
		options: vscode.LanguageModelToolInvocationOptions<IInsertAtLineParams>,
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
			options.input.content === undefined ||
			options.input.line === undefined
		) {
			throw new Error(
				'Invalid input: filePath, line, and content are required',
			);
		}

		const lineNumber = options.input.line;
		if (lineNumber < 1) {
			throw new Error('Line number must be at least 1 (1-indexed)');
		}

		// Check that the file exists
		const exists = await this.instantiationService.invokeFunction(
			canExistingFileBeEdited,
			uri,
		);
		if (!exists) {
			throw new Error(
				`File does not exist: ${options.input.filePath}. Use the ${ToolName.CreateFile} tool to create new files.`,
			);
		}

		const doc =
			await this.workspaceService.openTextDocumentAndSnapshot(uri);
		const lines = doc.getText().split('\n');
		const totalLines = lines.length;

		// Validate line number is within bounds (allow line = totalLines + 1 for appending)
		if (lineNumber > totalLines + 1) {
			throw new Error(
				`Line ${lineNumber} is out of range. File has ${totalLines} lines.`,
			);
		}

		const fileExtension = extname(uri);
		const modelId =
			options.model &&
			(await this.endpointProvider.getChatEndpoint(options.model)).model;

		// Determine insert position
		const position = options.input.position ?? 'before';
		let insertLineIndex: number;

		if (position === 'before') {
			// Insert before the specified line (0-indexed: line - 1)
			insertLineIndex = lineNumber - 1;
		} else {
			// Insert after the specified line (0-indexed: line)
			insertLineIndex = lineNumber;
		}

		// Create the edit
		const contentToInsert = options.input.content.endsWith('\n')
			? options.input.content
			: options.input.content + '\n';

		const insertPosition =
			insertLineIndex >= totalLines
				? new Range(
					totalLines - 1,
					lines[totalLines - 1]?.length ?? 0,
					totalLines - 1,
					lines[totalLines - 1]?.length ?? 0,
				)
				: new Range(insertLineIndex, 0, insertLineIndex, 0);

		const textToInsert =
			insertLineIndex >= totalLines
				? '\n' + options.input.content
				: contentToInsert;

		const edit = new TextEdit(insertPosition, textToInsert);
		this._promptContext.stream.textEdit(uri, [edit]);

		this.sendTelemetry(
			options.chatRequestId,
			modelId,
			fileExtension,
			lineNumber,
			position,
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
						toolName: ToolName.InsertAtLine,
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
		input: IInsertAtLineParams,
		promptContext: IBuildPromptContext,
	): Promise<IInsertAtLineParams> {
		this._promptContext = promptContext;
		return input;
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IInsertAtLineParams>,
		token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const uri = resolveToolInputPath(
			options.input.filePath,
			this.promptPathRepresentationService,
		);
		const content = options.input.content || '';
		const lineNumber = options.input.line;
		const position = options.input.position ?? 'before';

		// Get current file content for diff preview
		let oldContent = '';
		let newContent = '';
		try {
			const doc =
				await this.workspaceService.openTextDocumentAndSnapshot(uri);
			oldContent = doc.getText();
			const lines = oldContent.split('\n');

			// Calculate what the file will look like after insertion
			const insertLineIndex =
				position === 'before' ? lineNumber - 1 : lineNumber;
			const contentLines = content.split('\n');

			if (insertLineIndex >= lines.length) {
				// Append at end
				newContent =
					oldContent +
					(oldContent.endsWith('\n') ? '' : '\n') +
					content;
			} else {
				// Insert at position
				const before = lines.slice(0, insertLineIndex);
				const after = lines.slice(insertLineIndex);
				newContent = [...before, ...contentLines, ...after].join('\n');
			}
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

		const positionText = position === 'before' ? 'before' : 'after';
		return {
			...confirmation,
			presentation: undefined,
			invocationMessage: new MarkdownString(
				l10n.t`Inserting content ${positionText} line ${lineNumber} in ${formatUriForFileWidget(uri)}`,
			),
			pastTenseMessage: new MarkdownString(
				l10n.t`Inserted content ${positionText} line ${lineNumber} in ${formatUriForFileWidget(uri)}`,
			),
		};
	}

	private sendTelemetry(
		requestId: string | undefined,
		model: string | undefined,
		fileExtension: string,
		lineNumber: number,
		position: string,
	) {
		/* __GDPR__
			"insertAtLineToolInvoked" : {
				"owner": "roblourens",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
				"fileExtension": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The file extension of the file being edited" },
				"position": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether inserting before or after the line" }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent(
			'insertAtLineToolInvoked',
			{
				requestId,
				model,
				fileExtension,
				position,
			},
			{
				lineNumber,
			},
		);
	}
}

ToolRegistry.registerTool(InsertAtLineTool);
