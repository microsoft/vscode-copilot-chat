/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, PreparedToolInvocation, ProviderResult } from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { ChatReplayResponses } from '../../replay/common/chatReplayResponses';

type ToolReplayParams = {
	toolCallId: string;
	toolName: string;
	toolCallArgs: { [key: string]: any };
}

export class ToolReplayTool implements LanguageModelTool<ToolReplayParams> {
	public static readonly toolName = ToolName.ToolReplay;

	invoke(options: LanguageModelToolInvocationOptions<ToolReplayParams>, token: CancellationToken) {
		const replay = ChatReplayResponses.getInstance();
		const { toolCallId } = options.input;
		const toolResults = replay.getToolResult(toolCallId) ?? [];

		return new LanguageModelToolResult(toolResults.map(result => new LanguageModelTextPart(result)));
	}

	prepareInvocation(options: LanguageModelToolInvocationPrepareOptions<ToolReplayParams>, token: CancellationToken): ProviderResult<PreparedToolInvocation> {
		return {
			invocationMessage: options.input.toolName
		};
	}

}

ToolRegistry.registerTool(ToolReplayTool);
