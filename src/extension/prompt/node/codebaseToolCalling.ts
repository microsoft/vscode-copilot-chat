/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { IToolCallingLoopOptions, ToolCallingLoop } from '../../intents/node/toolCallingLoop';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { CodebaseAgentPrompt } from '../../prompts/node/panel/codebaseAgentPrompt';
import { IToolsService } from '../../tools/common/toolsService';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface ICodebaseToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
}

export class CodebaseToolCallingLoop extends ToolCallingLoop<ICodebaseToolCallingLoopOptions> {

	public static readonly ID = 'codebaseTool';

	constructor(
		options: ICodebaseToolCallingLoopOptions,
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
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			CodebaseAgentPrompt,
			{
				promptContext: buildPromptContext
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		return this.toolsService.getEnabledTools(this.options.request, tool => tool.tags.includes('vscode_codesearch'));
	}

	protected async fetch(messages: Raw.ChatMessage[], finishedCb: FinishedCallback, requestOptions: OptionalChatRequestParams, firstFetchCall: boolean, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest(
			CodebaseToolCallingLoop.ID,
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
				messageId: randomUUID(), // @TODO@joyceerhl
				messageSource: CodebaseToolCallingLoop.ID
			},
			{ intent: true }
		);
	}
}
