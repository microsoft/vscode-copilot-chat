/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { ReadFileParams } from './readFileTool';

export class CodexTool implements ICopilotTool<ReadFileParams> {
	public static toolName = ToolName.ConfirmationTool;

	constructor() { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<any>, token: vscode.CancellationToken) {
		return new LanguageModelToolResult([]);
	}

	prepareInvocation2(options: vscode.LanguageModelToolInvocationPrepareOptions<any>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		// return new PreparedTerminalToolInvocation(options.input.detail,
		// 	'sh',
		// 	{
		// 		title: options.input.message,
		// 		message: ''
		// 	}
		// );
		return {
			confirmationMessages: {
				title: options.input.message,
				message: new MarkdownString(options.input.detail),
			}
		};
	}
}

ToolRegistry.registerTool(CodexTool);
