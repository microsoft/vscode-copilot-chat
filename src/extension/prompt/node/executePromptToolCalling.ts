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
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { AgentPrompt } from '../../prompts/node/agent/agentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
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
		@IToolsService private readonly toolsService: IToolsService,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThinkingDataService thinkingDataService: IThinkingDataService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, thinkingDataService);
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
		// Reuse the same set of enabled tools as the main agent loop
		return this.toolsService.getEnabledTools(this.options.request, tool => {
			if (tool.name === ToolName.ExecutePrompt) {
				return false;
			}
		});
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
