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
import { DECORATION_TYPE } from './highlightLinesTool';

export interface IClearHighlightsParams {
	filePath: string;
}

export class ClearHighlightsTool implements ICopilotTool<IClearHighlightsParams> {
	public static readonly toolName = ToolName.ClearHighlights;

	constructor(
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IClearHighlightsParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		// resolve the file path
		let uri;
		try {
			uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: false, error: `Failed to resolve path: ${options.input.filePath}. Error: ${error instanceof Error ? error.message : String(error)}` }))
			]);
		}

		// if the file isn't open, do nothing
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
		if (!editor) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ success: true, message: `File not open, nothing to clear.` }))
			]);
		}

		// clear decorations
		editor.setDecorations(DECORATION_TYPE, []);

		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify({ success: true }))
		]);
	}
}

ToolRegistry.registerTool(ClearHighlightsTool);