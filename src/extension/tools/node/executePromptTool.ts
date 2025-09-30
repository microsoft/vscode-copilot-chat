/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ExecutePromptToolCallingLoop } from '../../prompt/node/executePromptToolCalling';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IExecutePromptParams {
	prompt: string;
	description: string;
}

class ExecutePromptTool implements ICopilotTool<IExecutePromptParams> {
	public static readonly toolName = ToolName.ExecutePrompt;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IExecutePromptParams>, token: vscode.CancellationToken) {

		const loop = this.instantiationService.createInstance(ExecutePromptToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: options.input.prompt })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.prompt,
		});

		// I want to render this content as thinking blocks when we they include tool calls
		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart
		);

		const loopResult = await loop.run(stream, token);
		// Return the text of the last assistant response from the tool calling loop
		const lastRoundResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(lastRoundResponse)]);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IExecutePromptParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { input } = options;
		try {
			return {
				invocationMessage: input.description,
			};
		} catch {
			return;
		}
	}

	async resolveInput(input: IExecutePromptParams, promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IExecutePromptParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(ExecutePromptTool);
