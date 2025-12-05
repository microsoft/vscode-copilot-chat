/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONTree } from '@vscode/prompt-tsx';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { SearchSubagentPrompt } from '../../prompts/node/agent/searchSubagentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

// Local function to render PromptTsx parts to strings (simplified to avoid vscode-node import restrictions)
function renderToolResultToStringNoBudget(part: LanguageModelPromptTsxPart): string {
	// Simple JSON serialization of the prompt-tsx element
	// This is a simplified version that doesn't require the full rendering pipeline
	const json = part.value as JSONTree.PromptElementJSON;
	return JSON.stringify(json, null, 2);
}

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

		const loopResult = await loop.run(stream, token);

		// Write trajectory to file in same format as logToolCall
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const trajectoryFile = path.join(os.homedir(), `search_trajectory-${timestamp}.json`);

		try {
			// Build a structured trajectory similar to chat-export-logs format
			const rounds: Array<{
				role: 'assistant' | 'tool';
				content: Array<{ type: 'text' | 'data'; text?: string; data?: unknown }>;
				toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
				toolCallId?: string;
				thinking?: unknown;
			}> = [];

			for (const round of loopResult.toolCallRounds) {
				// Assistant message with tool calls
				if (round.toolCalls.length > 0) {
					rounds.push({
						role: 'assistant',
						content: round.response ? [{ type: 'text', text: round.response }] : [],
						toolCalls: round.toolCalls.map(tc => ({
							id: tc.id,
							name: tc.name,
							arguments: JSON.parse(tc.arguments)
						})),
						thinking: round.thinking
					});

					// Tool results - render them properly
					for (const toolCall of round.toolCalls) {
						const result = loopResult.toolCallResults[toolCall.id];
						if (result) {
							const content: Array<{ type: 'text' | 'data'; text?: string; data?: unknown }> = [];
							for (const part of result.content) {
								if (part instanceof LanguageModelTextPart) {
									content.push({ type: 'text', text: part.value });
								} else if (part instanceof LanguageModelDataPart) {
									content.push({ type: 'data', data: part.data });
								} else if (part instanceof LanguageModelPromptTsxPart) {
									// Render prompt-tsx parts to readable text
									const rendered = renderToolResultToStringNoBudget(part);
									content.push({ type: 'text', text: rendered });
								} else {
									content.push({ type: 'text', text: String(part) });
								}
							}
							rounds.push({
								role: 'tool',
								content: content,
								toolCallId: toolCall.id
							});
						}
					}
				} else {
					// Final assistant message without tool calls
					rounds.push({
						role: 'assistant',
						content: [{ type: 'text', text: round.response }]
					});
				}
			}

			const trajectory = {
				id: `search-subagent-${timestamp}`,
				kind: 'toolCall',
				tool: ToolName.SearchSubagent,
				metadata: {
					query: options.input.query,
					description: options.input.description,
					time: new Date().toISOString(),
					responseType: loopResult.response.type,
					success: loopResult.response.type === ChatFetchResponseType.Success
				},
				conversation: rounds,
				finalResponse: loopResult.round.response
			};

			fs.writeFileSync(trajectoryFile, JSON.stringify(trajectory, null, 2), 'utf-8');
			console.log('[SearchSubagent] Wrote trajectory to:', trajectoryFile);
		} catch (error) {
			console.error('[SearchSubagent] FAILED to write trajectory to:', trajectoryFile, error);
		}

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
