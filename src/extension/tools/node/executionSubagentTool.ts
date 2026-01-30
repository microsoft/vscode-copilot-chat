/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseNotebookEditPart, ChatResponseTextEditPart, ChatToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ExecutionSubagentToolCallingLoop } from '../../prompt/node/executionSubagentToolCallingLoop';
import { ExecutionSubagentPrompt } from '../../prompts/node/agent/executionSubagentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IExecutionSubagentParams {

	/** What to execute, and what to look for in the output. Can include an exact command to run, or a description of an execution task. */
	query: string;
	/** User-visible description shown while invoking */
	description: string;
}

class ExecutionSubagentTool implements ICopilotTool<IExecutionSubagentParams> {
	public static readonly toolName = ToolName.ExecutionSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<IExecutionSubagentParams>, token: vscode.CancellationToken) {
		const executionInstruction = [
			`Query: ${options.input.query}`,
			'',
			'You are a specialized execution subagent. Use these tools to perform an execution task and return relevant portions of the execution output',
			'according to the specified query:',
			'- run_in_terminal: Execute the provided command in the terminal to obtain output.',
			'- read_file: Read the contents of files as part of the execution task.',
			'- grep_search: Search for specific patterns within files to find relevant information.',
			'- apply_patch: Apply a patch to a file as part of the execution task.',
			'',
			'You can use all of these tools multiple times if necessary. However, when the task is complete, filter through all the tool output and return the relevant portions in this exact format:',
			'',
			'<final_answer>',
			'{',
			' \"command_or_tool\": \"<a command that was run, or the name of a tool that was invoked>\",',
			' \"output\": \"relevant output excerpts from the command or tool invocation\"',
			'}',
			'{',
			' \"command_or_tool\": \"<another command that was run, or the name of a tool that was invoked>\",',
			' \"output\": \"relevant output excerpts from the command or tool invocation\"',
			'}',
			'...',
			'</final_answer>',
			'',
			'Return an empty <final_answer></final_answer> block if no portion of any command output is relevant to the query.',
			'Do not include any explanation or additional text outside the <final_answer> tags.',
			''
		].join('\n');

		const loop = this.instantiationService.createInstance(ExecutionSubagentToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: executionInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.query,
			allowedTools: new Set([ToolName.CoreRunInTerminal, ToolName.ReadFile, ToolName.FindTextInFiles, ToolName.ApplyPatch]),
			customPromptClass: ExecutionSubagentPrompt as typeof ExecutionSubagentPrompt & PromptElementCtor,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a new capturing token to group this execution subagent and all its nested tool calls
		// Similar to how DefaultIntentRequestHandler does it
		const executionSubagentToken = new CapturingToken(
			`Execution: ${options.input.query.substring(0, 50)}${options.input.query.length > 50 ? '...' : ''}`,
			'execution',
			false
		);

		// Wrap the loop execution in captureInvocation with the new token
		// All nested tool calls will now be logged under this same CapturingToken
		const loopResult = await this.requestLogger.captureInvocation(executionSubagentToken, () => loop.run(stream, token));

		// Build subagent trajectory metadata that will be logged via toolMetadata
		// All nested tool calls are already logged by ToolCallingLoop.logToolResult()
		const toolMetadata = {
			query: options.input.query,
			description: options.input.description
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The execution subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		// toolMetadata will be automatically included in exportAllPromptLogsAsJsonCommand
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IExecutionSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: IExecutionSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IExecutionSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(ExecutionSubagentTool);
