/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { SearchSubagentPrompt } from '../../prompts/node/agent/searchSubagentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface ISearchSubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
}

export class SearchSubagentToolCallingLoop extends ToolCallingLoop<ISearchSubagentToolCallingLoopOptions> {

	public static readonly ID = 'searchSubagentTool';

	constructor(
		options: ISearchSubagentToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IToolsService private readonly toolsService: IToolsService,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				subAgentInvocationId: randomUUID(),
				subAgentName: 'search'
			};
		}
		context.query = this.options.promptText;
		return context;
	}

	private async getEndpoint(request: ChatRequest) {
		const modelName = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentModel, this._experimentationService) as ChatEndpointFamily;
		let endpoint = await this.endpointProvider.getChatEndpoint(modelName);
		if (!endpoint.supportsToolCalls) {
			endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		}
		return endpoint;
	}

	protected async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint(this.options.request);
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			SearchSubagentPrompt,
			{
				promptContext: buildPromptContext
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const endpoint = await this.getEndpoint(this.options.request);
		const allTools = this.toolsService.getEnabledTools(this.options.request, endpoint);

		// Only include tools relevant for search operations.
		// We include semantic_search (Codebase) and the basic search primitives.
		// The Codebase tool checks for inSubAgent context to prevent nested tool calling loops.
		const allowedSearchTools = new Set([
			ToolName.Codebase,  // Semantic search
			ToolName.FindFiles,
			ToolName.FindTextInFiles,
			ToolName.ReadFile
		]);

		return allTools.filter(tool => allowedSearchTools.has(tool.name as ToolName));
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest2({
			debugName: SearchSubagentToolCallingLoop.ID,
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
				messageSource: SearchSubagentToolCallingLoop.ID
			},
		}, token);
	}
}
