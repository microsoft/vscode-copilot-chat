/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart } from '../../../vscodeTypes';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { SkillSubagentPrompt } from '../../prompts/node/agent/skillSubagentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface ISkillSubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
	skillInstructions: string;
	subAgentInvocationId?: string;
}

export class SkillSubagentToolCallingLoop extends ToolCallingLoop<ISkillSubagentToolCallingLoopOptions> {

	public static readonly ID = 'skillSubagentTool';

	constructor(
		options: ISkillSubagentToolCallingLoopOptions,
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
		@IFileSystemService fileSystemService: IFileSystemService,
		@IOTelService otelService: IOTelService,
		@IGitService gitService: IGitService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService, chatHookService, sessionTranscriptService, fileSystemService, otelService, gitService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				subAgentInvocationId: this.options.subAgentInvocationId ?? randomUUID(),
				subAgentName: 'skill'
			};
		}
		context.query = this.options.promptText;
		return context;
	}

	protected async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			SkillSubagentPrompt,
			{
				promptContext: buildPromptContext,
				skillInstructions: this.options.skillInstructions,
				maxTurns: this.options.toolCallLimit,
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		const allTools = this.toolsService.getEnabledTools(this.options.request, endpoint);

		// The skill subagent gets access to all tools the parent agent has,
		// except for the loadSkill tool itself (to prevent recursion) and
		// other subagent tools.
		const disallowedTools = new Set([
			ToolName.LoadSkill,
			ToolName.ExecutionSubagent,
			ToolName.SearchSubagent,
			ToolName.CoreRunSubagent,
		]);

		return allTools.filter(tool => !disallowedTools.has(tool.name as ToolName));
	}

	protected async fetch({ messages, finishedCb, requestOptions, enableThinking, reasoningEffort }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.endpointProvider.getChatEndpoint(this.options.request);
		return endpoint.makeChatRequest2({
			debugName: SkillSubagentToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			enableThinking,
			reasoningEffort,
			requestOptions: {
				...(requestOptions ?? {}),
				temperature: 0
			},
			userInitiatedRequest: false,
			telemetryProperties: {
				messageId: randomUUID(),
				messageSource: 'chat.editAgent',
				subType: 'subagent/skill',
				conversationId: this.options.conversation.sessionId
			},
		}, token);
	}
}
