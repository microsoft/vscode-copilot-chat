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
import { IBuildPromptContext } from '../../prompt/common/intents';
import { IBuildPromptResult } from '../../prompt/node/intents';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { IMcpToolCallingLoopPromptContext, McpToolCallingLoopPrompt } from './mcpToolCallingLoopPrompt';
import { QuickInputTool, QuickPickTool } from './mcpToolCallingTools';

export interface IMcpToolCallingLoopOptions extends IToolCallingLoopOptions {
	props: IMcpToolCallingLoopPromptContext;
}

export class McpToolCallingLoop extends ToolCallingLoop<IMcpToolCallingLoopOptions> {
	public static readonly ID = 'mcpToolSetupLoop';

	constructor(
		options: IMcpToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThinkingDataService thinkingDataService: IThinkingDataService
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
			McpToolCallingLoopPrompt,
			{
				promptContext: buildPromptContext,
				...this.options.props
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		if (this.options.conversation.turns.length > 5) {
			return []; // force a response
		}

		return [{
			description: QuickInputTool.description,
			name: QuickInputTool.ID,
			inputSchema: QuickInputTool.schema,
			source: undefined,
			tags: [],
		}, {
			description: QuickPickTool.description,
			name: QuickPickTool.ID,
			inputSchema: QuickPickTool.schema,
			source: undefined,
			tags: [],
		}];
	}

	protected async fetch(messages: Raw.ChatMessage[], finishedCb: FinishedCallback, requestOptions: OptionalChatRequestParams, firstFetchCall: boolean, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest(
			McpToolCallingLoop.ID,
			messages,
			finishedCb,
			token,
			ChatLocation.Agent,
			undefined,
			{
				...requestOptions,
				temperature: 0
			},
			firstFetchCall,
			{
				messageId: randomUUID(),
				messageSource: McpToolCallingLoop.ID
			},
			{ intent: true }
		);
	}
}
