/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';

export interface IRunSubagentParams {
	prompt: string;
	description: string;
}

class RunSubagentTool implements ICopilotTool<IRunSubagentParams> {
	public static readonly toolName = ToolName.RunSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRunSubagentParams>, token: vscode.CancellationToken) {

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: options.input.prompt })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.prompt,
		});

		// I want to render this content as thinking blocks when we they include tool calls
		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		const loopResult = await loop.run(stream, token);
		// Return the text of the last assistant response from the tool calling loop, or request error
		let subagentSummary = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentSummary = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentSummary = `The subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentSummary)]);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunSubagentParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { input } = options;
		try {
			return {
				invocationMessage: input.description,
			};
		} catch {
			return;
		}
	}

	async resolveInput(input: IRunSubagentParams, promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IRunSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(RunSubagentTool);
