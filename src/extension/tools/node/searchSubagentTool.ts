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
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { SearchSubagentPrompt } from '../../prompts/node/agent/searchSubagentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface ISearchSubagentParams {

	/** Natural language query describing what to search for */
	query: string;
	/** User-visible description shown while invoking */
	description: string;
}

class SearchSubagentTool implements ICopilotTool<ISearchSubagentParams> {
	public static readonly toolName = ToolName.SearchSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ISearchSubagentParams>, token: vscode.CancellationToken) {
		const searchInstruction = [
			`Search objective: ${options.input.query}`,
			'',
			'You are a specialized search subagent. Use these tools to gather and refine relevant code context.',
			'- semantic_search: Broad semantic retrieval. Use first for general or conceptual queries.',
			'- file_search: Discover candidate files/directories via glob patterns.',
			'- grep_search: Precise pattern or symbol matching; gather surrounding lines for verification.',
			'- read_file: Read specific files to extract relevant information.',
			'',
			'After completing your search, return the most relevant code contexts in this exact format:',
			'',
			'<final_answer>',
			'/absolute/path/to/file1.txt:10-20',
			'/absolute/path/to/file2.txt:1-30',
			'</final_answer>',
			'',
			'Each line should contain:',
			'- The absolute file path',
			'- A colon (:)',
			'- The starting line number',
			'- A dash (-)',
			'- The ending line number',
			'',
			'Use line range 1--1 to indicate an entire file.',
			'Return an empty <final_answer></final_answer> block if no relevant contexts are found.',
			'Do not include any explanation or additional text outside the <final_answer> tags.',
			''
		].join('\n');

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: searchInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.query,
			allowedTools: new Set([ToolName.Codebase, ToolName.FindFiles, ToolName.FindTextInFiles, ToolName.ReadFile]),
			customPromptClass: SearchSubagentPrompt as typeof SearchSubagentPrompt & PromptElementCtor,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a new capturing token to group this search subagent and all its nested tool calls
		// Similar to how DefaultIntentRequestHandler does it
		const searchSubagentToken = new CapturingToken(
			`Search: ${options.input.query.substring(0, 50)}${options.input.query.length > 50 ? '...' : ''}`,
			'search',
			false
		);

		// Wrap the loop execution in captureInvocation with the new token
		// All nested tool calls will now be logged under this same CapturingToken
		const loopResult = await this.requestLogger.captureInvocation(searchSubagentToken, () => loop.run(stream, token));

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
			subagentResponse = `The search subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		// toolMetadata will be automatically included in exportAllPromptLogsAsJsonCommand
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: ISearchSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<ISearchSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(SearchSubagentTool);
