/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { DEBUG_ALLOWED_TOOLS } from '../../debug/common/debugConstants';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { DebugSubagentPrompt } from '../../prompts/node/agent/debugSubagentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface IDebugSubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	/**
	 * Model family to use for endpoint selection as a fallback.
	 * Defaults to 'gpt-4.1'.
	 */
	modelFamily?: ChatEndpointFamily;
	location: ChatLocation;
	promptText: string;
	/** Optional pre-generated subagent invocation ID. If not provided, a new UUID will be generated. */
	subAgentInvocationId?: string;
}

export class DebugSubagentToolCallingLoop extends ToolCallingLoop<IDebugSubagentToolCallingLoopOptions> {

	public static readonly ID = 'debugSubagentTool';

	constructor(
		options: IDebugSubagentToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IToolsService private readonly toolsService: IToolsService,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IChatHookService chatHookService: IChatHookService,
		@ISessionTranscriptService sessionTranscriptService: ISessionTranscriptService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService, chatHookService, sessionTranscriptService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				subAgentInvocationId: this.options.subAgentInvocationId ?? randomUUID(),
				subAgentName: 'debug'
			};
		}
		context.query = this.options.promptText;
		return context;
	}

	/**
	 * Get the endpoint using the request or falling back to modelFamily.
	 */
	private async _getEndpoint() {
		// Use modelFamily as fallback if request doesn't have model preference
		return this.endpointProvider.getChatEndpoint(this.options.modelFamily ?? this.options.request);
	}

	protected async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this._getEndpoint();
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			DebugSubagentPrompt,
			{
				promptContext: buildPromptContext,
				maxDebugTurns: 10
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const endpoint = await this._getEndpoint();

		// Use the filter parameter to force-enable debug tools that aren't in the request's tool picker
		const allTools = this.toolsService.getEnabledTools(this.options.request, endpoint, (tool) => {
			if (DEBUG_ALLOWED_TOOLS.has(tool.name as ToolName)) {
				return true; // Force-enable debug tools
			}
			return undefined; // Let default logic handle other tools
		});
		return allTools.filter(tool => DEBUG_ALLOWED_TOOLS.has(tool.name as ToolName));
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this._getEndpoint();
		return endpoint.makeChatRequest2({
			debugName: DebugSubagentToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			requestOptions: {
				...requestOptions,
				temperature: 0
			},
			// This loop is inside a tool called from another request, so never user initiated
			userInitiatedRequest: false,
			telemetryProperties: {
				messageId: randomUUID(),
				messageSource: 'chat.editAgent',
				subType: 'subagent/debug'
			},
		}, token);
	}
}
