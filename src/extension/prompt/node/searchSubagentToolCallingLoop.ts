/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ProxyAgenticSearchEndpoint } from '../../../platform/endpoint/node/proxyAgenticSearchEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { PauseController } from '../../intents/node/pauseController';
import { IToolCallingLoopOptions, IToolCallLoopResult, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
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
	/** Optional pre-generated subagent invocation ID. If not provided, a new UUID will be generated. */
	subAgentInvocationId?: string;
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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IChatHookService chatHookService: IChatHookService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService, chatHookService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				subAgentInvocationId: this.options.subAgentInvocationId ?? randomUUID(),
				subAgentName: 'search'
			};
		}
		context.query = this.options.promptText;
		return context;
	}

	/**
	 * Get the endpoint to use for the search subagent
	 */
	private async getEndpoint() {
		const modelName = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentModel, this._experimentationService) as ChatEndpointFamily | undefined;
		const useAgenticProxy = this.configurationService.getConfig(ConfigKey.Advanced.SearchSubagentUseAgenticProxy);
		if (useAgenticProxy) {
			return this.instantiationService.createInstance(ProxyAgenticSearchEndpoint);
		}

		if (modelName) {
			try {
				// Try to get the specified model
				return await this.endpointProvider.getChatEndpoint(modelName);
			} catch (error) {
				// Model not available or doesn't support tool calls, fallback to main agent
				this._logService.warn(`Failed to get model ${modelName}, falling back to main agent endpoint: ${error}`);
				return await this.endpointProvider.getChatEndpoint(this.options.request);
			}
		} else {
			// No model name specified, use main agent endpoint
			return await this.endpointProvider.getChatEndpoint(this.options.request);
		}
	}

	protected async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint();
		const maxSearchTurns = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentToolCallLimit, this._experimentationService);
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			SearchSubagentPrompt,
			{
				promptContext: buildPromptContext,
				maxSearchTurns
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const endpoint = await this.getEndpoint();
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
		const endpoint = await this.getEndpoint();
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
				messageSource: 'chat.editAgent',
				subType: 'subagent/search'
			},
		}, token);
	}

	/**
	 * Gets the subagent ID for this loop.
	 */
	private getSubagentId(): string {
		return this.options.subAgentInvocationId ?? SearchSubagentToolCallingLoop.ID;
	}

	/**
	 * Gets the subagent type/name for this loop.
	 */
	private getSubagentType(): string {
		return 'search';
	}

	public override async run(outputStream: ChatResponseStream | undefined, token: CancellationToken | PauseController): Promise<IToolCallLoopResult> {
		const agentId = this.getSubagentId();
		const agentType = this.getSubagentType();

		// Execute SubagentStart hook
		this._logService.trace(`[SearchSubagentToolCallingLoop] Executing SubagentStart hook: agentId=${agentId}, agentType=${agentType}`);
		const startHookResult = await this.executeSubagentStartHook({
			agent_id: agentId,
			agent_type: agentType
		}, token);

		if (startHookResult.additionalContext) {
			this._logService.trace(`[SearchSubagentToolCallingLoop] SubagentStart hook provided additional context: ${startHookResult.additionalContext.substring(0, 100)}...`);
			// The additional context could be used to modify the prompt or behavior
			// For now, we log it. Subclasses could override createPromptContext to use it.
		}

		// Track if SubagentStop hook has blocked stopping
		let subagentStopHookActive = false;
		let lastResult: IToolCallLoopResult;

		// Run the main loop with SubagentStop hook integration
		while (true) {
			// Run the parent implementation
			lastResult = await super.run(outputStream, token);

			// Execute SubagentStop hook before returning
			this._logService.trace(`[SearchSubagentToolCallingLoop] Executing SubagentStop hook: agentId=${agentId}, agentType=${agentType}, stop_hook_active=${subagentStopHookActive}`);
			const stopHookResult = await this.executeSubagentStopHook({
				agent_id: agentId,
				agent_type: agentType,
				stop_hook_active: subagentStopHookActive
			}, outputStream, token);

			if (stopHookResult.shouldContinue && stopHookResult.reason) {
				// SubagentStop hook blocked stopping
				this.showSubagentStopHookBlockedMessage(outputStream, stopHookResult.reason);
				this._logService.info(`[SearchSubagentToolCallingLoop] SubagentStop hook blocked, continuing with reason: ${stopHookResult.reason}`);
				subagentStopHookActive = true;
				// Continue the loop - the parent run will handle the continuation
				continue;
			}

			// SubagentStop hook allowed stopping
			break;
		}

		return lastResult;
	}
}
