/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { getAgentTools } from '../../intents/node/agentIntent';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { AgentPrompt } from '../../prompts/node/agent/agentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface IExecutePromptToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
}

export class ExecutePromptToolCallingLoop extends ToolCallingLoop<IExecutePromptToolCallingLoopOptions> {

	public static readonly ID = 'executePromptTool';

	constructor(
		options: IExecutePromptToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService);
	}

	private async getEndpoint(request: ChatRequest) {
		let endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		if (!endpoint.supportsToolCalls) {
			endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');
		}
		return endpoint;
	}

	protected async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint(this.options.request);
		const promptContext: IBuildPromptContext = {
			...buildPromptContext,
			query: this.options.promptText,
			conversation: undefined
		};
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			AgentPrompt,
			{
				endpoint,
				promptContext,
				location: this.options.location,
				enableCacheBreakpoints: false,
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const excludedTools = new Set([ToolName.ExecutePrompt, ToolName.ExecuteTask, ToolName.CoreManageTodoList]);
		return (await getAgentTools(this.instantiationService, this.options.request))
			.filter(tool => !excludedTools.has(tool.name as ToolName))
			// TODO can't do virtual tools at this level
			.slice(0, 128);
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest(
			ExecutePromptToolCallingLoop.ID,
			messages,
			finishedCb,
			token,
			this.options.location,
			undefined,
			{
				...requestOptions,
				temperature: 0
			},
			// This loop is inside a tool called from another request, so never user initiated
			false,
			{
				messageId: randomUUID(),
				messageSource: ExecutePromptToolCallingLoop.ID
			},
		);
	}
}
