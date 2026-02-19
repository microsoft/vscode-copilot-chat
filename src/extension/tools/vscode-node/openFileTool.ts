/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { resolveToolInputPath } from '../node/toolUtils';

export interface IOpenFileParams {
	filePath: string;
}

export class OpenFileTool implements ICopilotTool<IOpenFileParams> {
	public static readonly toolName = ToolName.OpenFile;

	constructor(
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IOpenFileParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		// resolve the file path
		let uri;
		try {
			uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: `Failed to resolve path: ${options.input.filePath}. Error: ${error instanceof Error ? error.message : String(error)}` }))
			]);
		}

		// open the file
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document);

		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ success: true }))
		]);
	}
}

ToolRegistry.registerTool(OpenFileTool);