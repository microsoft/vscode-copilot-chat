/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { findNotebook } from '../../../util/common/notebooks';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatImageMimeType, ExtendedLanguageModelToolResult, LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { RunNotebookCellOutput } from './runNotebookCellTool';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { getCellIdMap } from '../../../platform/notebook/common/helpers';

export class GetNotebookCellOutputTool implements ICopilotTool<IGetNotebookCellOutputToolParams> {
	public static toolName = ToolName.ReadCellOutput;
	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAlternativeNotebookContentService protected readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IGetNotebookCellOutputToolParams>, token: vscode.CancellationToken) {
		const { filePath, cellId } = options.input;

		let uri = this.promptPathRepresentationService.resolveFilePath(filePath);
		if (!uri) {
			sendOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'invalid_file_path');
			throw new Error(`Invalid file path`);
		}
		// Sometimes we get the notebook cell Uri in the resource.
		// Resolve this to notebook.
		uri = findNotebook(uri, this.workspaceService.notebookDocuments)?.uri || uri;

		let notebook: vscode.NotebookDocument;
		try {
			notebook = await this.workspaceService.openNotebookDocument(uri);
		} catch (ex) {
			sendOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'failedToOpenNotebook');
			throw ex;
		}

		const cell = getCellIdMap(notebook).get(cellId);
		if (!cell) {
			sendOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'cellNotFound');
			throw new Error(`Cell not found, use the ${ToolName.ReadFile} file tool to get the latest content of the notebook file.`);
		}

		try {
			const outputs = cell.outputs;

			const toolCallResults: Array<LanguageModelPromptTsxPart | unknown> = [];
			const endpoint = this._promptContext?.request ? await this.endpointProvider.getChatEndpoint(this._promptContext?.request) : undefined;

			for (let i = 0; i < outputs.length; i++) {
				const output = outputs[i];
				const imageItem = endpoint?.supportsVision ? output.items.find((item) => item.mime === 'image/png' || item.mime === 'image/jpeg') : undefined;

				if (imageItem) {
					toolCallResults.push(new LanguageModelTextPart(`<cell-output>\nOutput ${i}:\n`));
					toolCallResults.push(LanguageModelDataPart.image(imageItem.data, imageItem.mime === 'image/png' ? ChatImageMimeType.PNG : ChatImageMimeType.JPEG));
					toolCallResults.push(new LanguageModelTextPart(`</cell-output>`));
				} else {
					toolCallResults.push(new LanguageModelPromptTsxPart(await renderPromptElementJSON(this.instantiationService, RunNotebookCellOutput, { output, index: i, sizeLimitRatio: 1.2 }, options.tokenizationOptions, token)));
				}
			}

			const result = new ExtendedLanguageModelToolResult(toolCallResults as any);

			const cellUri = cell?.document.uri;
			result.toolResultMessage = new MarkdownString(`Read output of [](${cellUri?.toString()})`);

			sendOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'success');
			return result;
		} catch (ex) {
			sendOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'error');
			throw ex;
		}
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IGetNotebookCellOutputToolParams>): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: l10n.t`Reading cell output`,
			pastTenseMessage: l10n.t`Read cell output`,
		};
	}

	async resolveInput(input: IGetNotebookCellOutputToolParams, promptContext: IBuildPromptContext): Promise<IGetNotebookCellOutputToolParams> {
		this._promptContext = promptContext;
		return input;
	}
}

interface IGetNotebookCellOutputToolParams {
	filePath: string;
	cellId: string;
}

ToolRegistry.registerTool(GetNotebookCellOutputTool);

async function sendOutcomeTelemetry(telemetryService: ITelemetryService, endpointProvider: IEndpointProvider | undefined, options: vscode.LanguageModelToolInvocationOptions<IGetNotebookCellOutputToolParams>, outcome: string) {
	const model = (options.model && endpointProvider && (await endpointProvider.getChatEndpoint(options.model)).model);

	/* __GDPR__
		"getNotebookCellOutput.toolOutcome" : {
			"owner": "donjayamanne",
			"comment": "Tracks the tool used to get Notebook cell outputs",
			"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
			"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook (this measure is used to identify notebook related telemetry)." },
			"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Outcome of the edit operation" },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
		}
	*/
	telemetryService.sendMSFTTelemetryEvent('getNotebookCellOutput.toolOutcome',
		{ requestId: options.chatRequestId, outcome, model }, { isNotebook: 1 }
	);
}
