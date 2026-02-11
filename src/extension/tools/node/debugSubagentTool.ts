/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseNotebookEditPart, ChatResponseTextEditPart, ChatToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { DebugSubagentToolCallingLoop } from '../../prompt/node/debugSubagentToolCallingLoop';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IDebugSubagentParams {
	/** Natural language query describing what to debug or analyze */
	query: string;
	/** User-visible description shown while invoking */
	description: string;
}

class DebugSubagentTool implements ICopilotTool<IDebugSubagentParams> {
	public static readonly toolName = ToolName.DebugSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDebugSubagentParams>, token: vscode.CancellationToken) {
		const debugInstruction = [
			`Debug analysis request: ${options.input.query}`,
			'',
			'Analyze and provide findings using the available debug tools.',
		].join('\n');

		const request = this._inputContext!.request!;
		const parentSessionId = this._inputContext?.conversation?.sessionId ?? generateUuid();
		// Generate a stable session ID for this subagent invocation
		const subAgentInvocationId = generateUuid();

		const loop = this.instantiationService.createInstance(DebugSubagentToolCallingLoop, {
			toolCallLimit: 20, // Debug analysis may need more iterations
			conversation: new Conversation(parentSessionId, [new Turn(generateUuid(), { type: 'user', message: debugInstruction })]),
			request: request,
			location: request.location,
			promptText: options.input.query,
			subAgentInvocationId: subAgentInvocationId,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		// Create a new capturing token to group this debug subagent and all its nested tool calls
		const debugSubagentToken = new CapturingToken(
			`Debug: ${options.input.query.substring(0, 50)}${options.input.query.length > 50 ? '...' : ''}`,
			'debug',
			false,
			false,
			subAgentInvocationId,
			'debug'  // subAgentName for trajectory tracking
		);

		// Wrap the loop execution in captureInvocation with the new token
		const loopResult = await this.requestLogger.captureInvocation(debugSubagentToken, () => loop.run(stream, token));

		// Build subagent trajectory metadata
		const toolMetadata = {
			query: options.input.query,
			description: options.input.description,
			subAgentInvocationId: subAgentInvocationId,
			agentName: 'debug'
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The debug subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		result.toolResultMessage = new MarkdownString(l10n.t`Debug analysis complete: ${options.input.description}`);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDebugSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: IDebugSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IDebugSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(DebugSubagentTool);
