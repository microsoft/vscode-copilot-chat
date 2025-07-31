/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as l10n from '@vscode/l10n';
import { Raw, RenderPromptResult } from '@vscode/prompt-tsx';
import { BudgetExceededError } from '@vscode/prompt-tsx/dist/base/materialized';
import type * as vscode from 'vscode';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { modelCanUseReplaceStringExclusively, modelSupportsApplyPatch, modelSupportsReplaceString } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService } from '../../../platform/tasks/common/tasksService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, RenderedUserMessageMetadata } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IBuildPromptResult, IIntent, IntentLinkificationOptions } from '../../prompt/node/intents';
import { AgentPrompt, AgentPromptProps } from '../../prompts/node/agent/agentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { TemporalContextStats } from '../../prompts/node/inline/temporalContext';
import { EditCodePrompt2 } from '../../prompts/node/panel/editCodePrompt2';
import { ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { VirtualTool } from '../../tools/common/virtualTools/virtualTool';
import { IToolGroupingService } from '../../tools/common/virtualTools/virtualToolTypes';
import { addCacheBreakpoints } from './cacheBreakpoints';
import { EditCodeIntent, EditCodeIntentInvocation, EditCodeIntentInvocationOptions, mergeMetadata, toNewChatReferences } from './editCodeIntent';
import { getRequestedToolCallIterationLimit, IContinueOnErrorConfirmation } from './toolCallingLoop';

const getTools = (instaService: IInstantiationService, request: vscode.ChatRequest) =>
	instaService.invokeFunction(async accessor => {
		const toolsService = accessor.get<IToolsService>(IToolsService);
		const testService = accessor.get<ITestProvider>(ITestProvider);
		const tasksService = accessor.get<ITasksService>(ITasksService);
		const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
		const experimentationService = accessor.get<IExperimentationService>(IExperimentationService);
		const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
		const model = await endpointProvider.getChatEndpoint(request);

		const allowTools: Record<string, boolean> = {};
		allowTools[ToolName.EditFile] = true;
		allowTools[ToolName.ReplaceString] = modelSupportsReplaceString(model) || !!(model.family.includes('gemini') && configurationService.getExperimentBasedConfig(ConfigKey.Internal.GeminiReplaceString, experimentationService));
		allowTools[ToolName.ApplyPatch] = await modelSupportsApplyPatch(model) && !!toolsService.getTool(ToolName.ApplyPatch);

		if (modelCanUseReplaceStringExclusively(model)) {
			allowTools[ToolName.ReplaceString] = true;
			allowTools[ToolName.EditFile] = false;
		}

		allowTools[ToolName.RunTests] = await testService.hasAnyTests();
		allowTools[ToolName.CoreRunTask] = !!(configurationService.getConfig(ConfigKey.AgentCanRunTasks) && tasksService.getTasks().length);

		return toolsService.getEnabledTools(request, tool => {
			if (typeof allowTools[tool.name] === 'boolean') {
				return allowTools[tool.name];
			}

			// Must return undefined to fall back to other checks
			return undefined;
		});
	});

export class AgentIntent extends EditCodeIntent {

	static override readonly ID = Intent.Agent;

	override readonly id = AgentIntent.ID;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IToolGroupingService private readonly _toolGroupingService: IToolGroupingService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { intentInvocation: AgentIntentInvocation, processCodeblocks: false });
	}

	override async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {
		if (request.command === 'list') {
			await this.listTools(request, stream, token);
			return {};
		}

		return super.handleRequest(conversation, request, stream, token, documentContext, agentName, location, chatTelemetry, onPaused);
	}

	private async listTools(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken) {
		const editingTools = await getTools(this.instantiationService, request);
		const grouping = this._toolGroupingService.create(editingTools);
		if (!grouping.isEnabled) {
			stream.markdown(`Available tools: \n${editingTools.map(tool => `- ${tool.name}`).join('\n')}\n`);
			return;
		}

		let str = 'Available tools:\n';
		function printTool(tool: vscode.LanguageModelToolInformation | VirtualTool, indent = 0) {
			const prefix = '  '.repeat(indent * 2);
			str += `${prefix}- ${tool.name}`;
			if (tool instanceof VirtualTool) {
				if (tool.isExpanded) {
					str += ` (expanded):`;
				} else {
					str += ': ' + tool.description.split('\n\n').map((chunk, i) => i > 0 ? prefix + '  ' + chunk : chunk).join('\n\n');
				}
			}
			str += '\n';
			if (tool instanceof VirtualTool && tool.contents.length > 0) {
				for (const child of tool.contents) {
					printTool(child, indent + 1);
				}
			}
		}

		const tools = await grouping.computeAll(token);
		tools.forEach(t => printTool(t));
		stream.markdown(str);

		return {};
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ??
				this.configurationService.getNonExtensionConfig('chat.agent.maxRequests') ??
				200, // Fallback for simulation tests
			temperature: this.configurationService.getConfig(ConfigKey.Internal.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Agent,
			hideRateLimitTimeEstimate: true
		};
	}
}

export class AgentIntentInvocation extends EditCodeIntentInvocation {

	public override get linkification(): IntentLinkificationOptions {
		// on by default:
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.EditLinkification) !== false;
		return { disable: !enabled };
	}

	public override readonly codeblocksRepresentEdits = false;

	protected prompt: typeof AgentPrompt | typeof EditCodePrompt2 = AgentPrompt;

	protected extraPromptProps: Partial<AgentPromptProps> | undefined;

	constructor(
		intent: IIntent,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		request: vscode.ChatRequest,
		intentOptions: EditCodeIntentInvocationOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IEnvService envService: IEnvService,
		@IPromptPathRepresentationService promptPathRepresentationService: IPromptPathRepresentationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IToolsService toolsService: IToolsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditLogService editLogService: IEditLogService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotebookService notebookService: INotebookService,
		@ILogService private readonly logService: ILogService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService);
	}

	public override getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return getTools(this.instantiationService, this.request);
	}

	override async buildPrompt(
		promptContext: IBuildPromptContext,
		progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>,
		token: vscode.CancellationToken
	): Promise<IBuildPromptResult> {
		// Add any references from the codebase invocation to the request
		const codebase = await this._getCodebaseReferences(promptContext, token);

		let variables = promptContext.chatVariables;
		let toolReferences: vscode.ChatPromptReference[] = [];
		if (codebase) {
			toolReferences = toNewChatReferences(variables, codebase.references);
			variables = new ChatVariablesCollection([...this.request.references, ...toolReferences]);
		}

		const tools = await this.getAvailableTools();
		const toolTokens = tools?.length ? await this.endpoint.acquireTokenizer().countToolTokens(tools) : 0;

		// Reserve extra space when tools are involved due to token counting issues
		const baseBudget = Math.min(
			this.configurationService.getConfig<number | undefined>(ConfigKey.Internal.SummarizeAgentConversationHistoryThreshold) ?? this.endpoint.modelMaxPromptTokens,
			this.endpoint.modelMaxPromptTokens
		);
		const safeBudget = Math.floor((baseBudget - toolTokens) * 0.85);
		const endpoint = toolTokens > 0 ? this.endpoint.cloneWithTokenOverride(safeBudget) : this.endpoint;
		const summarizationEnabled = this.configurationService.getExperimentBasedConfig(ConfigKey.SummarizeAgentConversationHistory, this.experimentationService) && this.prompt === AgentPrompt;
		this.logService.debug(`AgentIntent: rendering with budget=${safeBudget} (baseBudget: ${baseBudget}, toolTokens: ${toolTokens}), summarizationEnabled=${summarizationEnabled}`);
		let result: RenderPromptResult;
		const props: AgentPromptProps = {
			endpoint,
			promptContext: {
				...promptContext,
				tools: promptContext.tools && {
					...promptContext.tools,
					toolReferences: this.stableToolReferences.filter((r) => r.name !== ToolName.Codebase),
				}
			},
			location: this.location,
			enableCacheBreakpoints: summarizationEnabled,
			...this.extraPromptProps
		};
		try {
			const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, props);
			result = await renderer.render(progress, token);
		} catch (e) {
			if (e instanceof BudgetExceededError && summarizationEnabled) {
				this.logService.debug(`[Agent] budget exceeded, triggering summarization (${e.message})`);
				if (!promptContext.toolCallResults) {
					promptContext = {
						...promptContext,
						toolCallResults: {}
					};
				}
				e.metadata.getAll(ToolResultMetadata).forEach((metadata) => {
					promptContext.toolCallResults![metadata.toolCallId] = metadata.result;
				});
				try {
					const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
						...props,
						triggerSummarize: true,
					});
					result = await renderer.render(progress, token);
				} catch (e) {
					this.logService.error(e, `[Agent] summarization failed`);
					const errorKind = e instanceof BudgetExceededError ? 'budgetExceeded' : 'error';
					/* __GDPR__
						"triggerSummarizeFailed" : {
							"owner": "roblourens",
							"comment": "Tracks when triggering summarization failed - for example, a summary was created but not applied successfully.",
							"errorKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The success state or failure reason of the summarization." },
							"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used for the summarization." }
						}
					*/
					this.telemetryService.sendMSFTTelemetryEvent('triggerSummarizeFailed', { errorKind, model: props.endpoint.model });

					// Something else went wrong, eg summarization failed, so render the prompt with no cache breakpoints or summarization
					const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
						...props,
						enableCacheBreakpoints: false
					});
					result = await renderer.render(progress, token);
				}
			} else {
				throw e;
			}
		}

		const lastMessage = result.messages.at(-1);
		if (lastMessage?.role === Raw.ChatRole.User) {
			const currentTurn = promptContext.conversation?.getLatestTurn();
			if (currentTurn && !currentTurn.getMetadata(RenderedUserMessageMetadata)) {
				currentTurn.setMetadata(new RenderedUserMessageMetadata(lastMessage.content));
			}
		}

		addCacheBreakpoints(result.messages);

		if (this.request.command === 'error') {
			// Should trigger a 400
			result.messages.push({
				role: Raw.ChatRole.Assistant,
				content: [],
				toolCalls: [{ type: 'function', id: '', function: { name: 'tool', arguments: '{' } }]
			});
		}

		const tempoStats = result.metadata.get(TemporalContextStats);

		return {
			...result,
			// The codebase tool is not actually called/referenced in the edit prompt, so we ned to
			// merge its metadata so that its output is not lost and it's not called repeatedly every turn
			// todo@connor4312/joycerhl: this seems a bit janky
			metadata: codebase ? mergeMetadata(result.metadata, codebase.metadatas) : result.metadata,
			// Don't report file references that came in via chat variables in an editing session, unless they have warnings,
			// because they are already displayed as part of the working set
			// references: result.references.filter((ref) => this.shouldKeepReference(editCodeStep, ref, toolReferences, chatVariables)),
			telemetryData: tempoStats && [tempoStats]
		};
	}

	modifyErrorDetails(errorDetails: vscode.ChatErrorDetails, response: ChatResponse): vscode.ChatErrorDetails {
		errorDetails.confirmationButtons = [
			{ data: { copilotContinueOnError: true } satisfies IContinueOnErrorConfirmation, label: l10n.t('Try Again') },
		];
		return errorDetails;
	}

	override processResponse = undefined;
}
