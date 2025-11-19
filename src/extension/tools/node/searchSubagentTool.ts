/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { SearchSubagentPrompt } from '../../prompts/node/agent/searchSubagentPrompt';
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
	) { }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ISearchSubagentParams>, token: vscode.CancellationToken) {
		const searchInstruction = [
			`Search objective: ${options.input.query}`,
			'',
			'You are a specialized search subagent. Use these tools to gather and refine relevant code context.',
			'- semantic_search: Broad semantic retrieval. Use first for general or conceptual queries.',
			'- file_search: Discover candidate files/directories via glob patterns.',
			'- grep_search: Precise pattern or symbol matching; gather surrounding lines for verification.',
			'',
			'After completing your search, return ONLY a valid JSON array of the most relevant code contexts in this exact format:',
			'[',
			'  {',
			'    "file_path": "/absolute/path/to/file",',
			'    "line_start": 10,',
			'    "line_end": 20',
			'  }',
			']',
			'',
			'Include only the most relevant contexts that would help answer the search objective.',
			'Use line_end: -1 to indicate an entire file.',
			'Return an empty array [] if no relevant contexts are found.',
			'Do not include any explanation or additional text, only the JSON array.',
			''
		].join('\n');

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: searchInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.query,
			allowedTools: new Set([ToolName.Codebase, ToolName.FindFiles, ToolName.FindTextInFiles, ToolName.ReadFile]),
			customPromptClass: SearchSubagentPrompt,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		const loopResult = await loop.run(stream, token);

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The search subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
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
