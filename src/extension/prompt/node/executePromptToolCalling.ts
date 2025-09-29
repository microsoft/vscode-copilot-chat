/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
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
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';

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

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				inSubAgent: true
			};
		}
		context.query = this.options.promptText;
		context.chatVariables = new ChatVariablesCollection();
		context.conversation = undefined;
		return context;
	}

	private async getEndpoint(request: ChatRequest) {
		let endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		if (!endpoint.supportsToolCalls) {
			endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');
		}
		return endpoint;
	}

	protected async buildPrompt(promptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint(this.options.request);
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			AgentPrompt,
			{
				endpoint,
				promptContext: promptContext,
				location: this.options.location,
				enableCacheBreakpoints: false,
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const excludedTools = new Set([ToolName.ExecutePrompt, ToolName.CoreManageTodoList]);
		return (await getAgentTools(this.instantiationService, this.options.request))
			.filter(tool => !excludedTools.has(tool.name as ToolName))
			// TODO can't do virtual tools at this level
			.slice(0, 128);
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest2({
			debugName: ExecutePromptToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			requestOptions: {
				...(requestOptions ?? {}),
				temperature: 0,
				tools: normalizeToolSchema(
					endpoint.family,
					requestOptions?.tools,
					(tool, rule) => {
						this._logService.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
			},
			// This loop is inside a tool called from another request, so never user initiated
			userInitiatedRequest: false,
			telemetryProperties: {
				messageId: randomUUID(),
				messageSource: ExecutePromptToolCallingLoop.ID
			},
		}, token);
	}
}
