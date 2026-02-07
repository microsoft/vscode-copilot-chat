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
import { isAnthropicFamily, isGptFamily, modelCanUseApplyPatchExclusively, modelCanUseReplaceStringExclusively, modelSupportsApplyPatch, modelSupportsMultiReplaceString, modelSupportsReplaceString, modelSupportsSimplifiedApplyPatchInstructions } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { isAnthropicContextEditingEnabled } from '../../../platform/networking/common/anthropic';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService } from '../../../platform/tasks/common/tasksService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';

import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Event } from '../../../util/vs/base/common/event';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';

import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { AnthropicTokenUsageMetadata, Conversation, normalizeSummariesOnRounds, RenderedUserMessageMetadata } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { getRequestedToolCallIterationLimit, IContinueOnErrorConfirmation } from '../../prompt/common/specialRequestTypes';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IBuildPromptResult, IIntent, IIntentInvocation } from '../../prompt/node/intents';
import { AgentPrompt, AgentPromptProps } from '../../prompts/node/agent/agentPrompt';
import { AgentPromptCustomizations, PromptRegistry } from '../../prompts/node/agent/promptRegistry';
import { SummarizedConversationHistory, SummarizedConversationHistoryMetadata, SummarizedConversationHistoryPropsBuilder } from '../../prompts/node/agent/summarizedConversationHistory';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { EditCodePrompt2 } from '../../prompts/node/panel/editCodePrompt2';
import { NotebookInlinePrompt } from '../../prompts/node/panel/notebookInlinePrompt';
import { ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { IEditToolLearningService } from '../../tools/common/editToolLearningService';
import { ContributedToolName, ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { applyPatch5Description } from '../../tools/node/applyPatchTool';
import { getAgentMaxRequests } from '../common/agentConfig';
import { addCacheBreakpoints } from './cacheBreakpoints';
import { EditCodeIntent, EditCodeIntentInvocation, EditCodeIntentInvocationOptions, mergeMetadata, toNewChatReferences } from './editCodeIntent';

export const getAgentTools = async (accessor: ServicesAccessor, request: vscode.ChatRequest) => {
	const toolsService = accessor.get<IToolsService>(IToolsService);
	const testService = accessor.get<ITestProvider>(ITestProvider);
	const tasksService = accessor.get<ITasksService>(ITasksService);
	const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
	const experimentationService = accessor.get<IExperimentationService>(IExperimentationService);
	const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
	const editToolLearningService = accessor.get<IEditToolLearningService>(IEditToolLearningService);
	const model = await endpointProvider.getChatEndpoint(request);

	const allowTools: Record<string, boolean> = {};

	const learned = editToolLearningService.getPreferredEndpointEditTool(model);
	if (learned) { // a learning-enabled (BYOK) model, we should go with what it prefers
		allowTools[ToolName.EditFile] = learned.includes(ToolName.EditFile);
		allowTools[ToolName.ReplaceString] = learned.includes(ToolName.ReplaceString);
		allowTools[ToolName.MultiReplaceString] = learned.includes(ToolName.MultiReplaceString);
		allowTools[ToolName.ApplyPatch] = learned.includes(ToolName.ApplyPatch);
	} else {
		allowTools[ToolName.EditFile] = true;
		allowTools[ToolName.ReplaceString] = modelSupportsReplaceString(model);
		allowTools[ToolName.ApplyPatch] = modelSupportsApplyPatch(model) && !!toolsService.getTool(ToolName.ApplyPatch);

		if (allowTools[ToolName.ApplyPatch] && modelCanUseApplyPatchExclusively(model)) {
			allowTools[ToolName.EditFile] = false;
		}

		if (modelCanUseReplaceStringExclusively(model)) {
			allowTools[ToolName.ReplaceString] = true;
			allowTools[ToolName.EditFile] = false;
		}

		if (allowTools[ToolName.ReplaceString] && modelSupportsMultiReplaceString(model)) {
			allowTools[ToolName.MultiReplaceString] = true;
		}
	}

	allowTools[ToolName.CoreRunTest] = await testService.hasAnyTests();
	allowTools[ToolName.CoreRunTask] = tasksService.getTasks().length > 0;

	const useAgenticProxy = configurationService.getConfig(ConfigKey.Advanced.SearchSubagentUseAgenticProxy);
	const searchSubagentEnabled = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentToolEnabled, experimentationService);
	const isGptOrAnthropic = isGptFamily(model) || isAnthropicFamily(model);
	allowTools[ToolName.SearchSubagent] = isGptOrAnthropic && (useAgenticProxy && searchSubagentEnabled);

	if (model.family.includes('grok-code')) {
		allowTools[ToolName.CoreManageTodoList] = false;
	}

	allowTools[ToolName.EditFilesPlaceholder] = false;
	// todo@connor4312: string check here is for back-compat for 1.109 Insiders
	if (Iterable.some(request.tools, ([t, enabled]) => (typeof t === 'string' ? t : t.name) === ContributedToolName.EditFilesPlaceholder && enabled === false)) {
		allowTools[ToolName.ApplyPatch] = false;
		allowTools[ToolName.EditFile] = false;
		allowTools[ToolName.ReplaceString] = false;
		allowTools[ToolName.MultiReplaceString] = false;
	}

	if (model.family.toLowerCase().includes('gemini-3') && configurationService.getExperimentBasedConfig(ConfigKey.Advanced.Gemini3MultiReplaceString, experimentationService)) {
		allowTools[ToolName.MultiReplaceString] = true;
	}

	const tools = toolsService.getEnabledTools(request, model, tool => {
		if (typeof allowTools[tool.name] === 'boolean') {
			return allowTools[tool.name];
		}

		// Must return undefined to fall back to other checks
		return undefined;
	});

	if (modelSupportsSimplifiedApplyPatchInstructions(model) && configurationService.getExperimentBasedConfig(ConfigKey.Advanced.Gpt5AlternativePatch, experimentationService)) {
		const ap = tools.findIndex(t => t.name === ToolName.ApplyPatch);
		if (ap !== -1) {
			tools[ap] = { ...tools[ap], description: applyPatch5Description };
		}
	}

	return tools;
};

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
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { intentInvocation: AgentIntentInvocation, processCodeblocks: false });
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ??
				this.instantiationService.invokeFunction(getAgentMaxRequests),
			temperature: this.configurationService.getConfig(ConfigKey.Advanced.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Agent,
			hideRateLimitTimeEstimate: true
		};
	}

	override async handleRequest(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		documentContext: IDocumentContext | undefined,
		agentName: string,
		location: ChatLocation,
		chatTelemetry: ChatTelemetryBuilder,
		onPaused: Event<boolean>
	): Promise<vscode.ChatResult> {
		if (request.command === 'summarize') {
			return this.handleSummarizeCommand(conversation, request, stream, token);
		}

		return super.handleRequest(conversation, request, stream, token, documentContext, agentName, location, chatTelemetry, onPaused);
	}

	private async handleSummarizeCommand(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		const enabled = this.configurationService.getConfig(ConfigKey.SummarizeAgentConversationHistory);
		if (!enabled) {
			stream.markdown(l10n.t('Conversation history summarization is disabled. Enable it via `github.copilot.chat.summarizeAgentConversationHistory.enabled` setting.'));
			return {};
		}

		normalizeSummariesOnRounds(conversation.turns);

		// Exclude the current /summarize turn.
		const history = conversation.turns.slice(0, -1);
		if (history.length === 0) {
			stream.markdown(l10n.t('Nothing to summarize. Start a conversation first.'));
			return {};
		}

		// The summarization metadata needs to be associated with a tool call round.
		const lastRoundId = history.at(-1)?.rounds.at(-1)?.id;
		if (!lastRoundId) {
			stream.markdown(l10n.t('Nothing to summarize. Start a conversation with tool calls first.'));
			return {};
		}

		const endpoint = await this.endpointProvider.getChatEndpoint(request);

		const promptContext: IBuildPromptContext = {
			history,
			chatVariables: new ChatVariablesCollection([]),
			query: '',
			toolCallRounds: [],
			conversation,
		};

		try {
			const propsBuilder = this.instantiationService.createInstance(SummarizedConversationHistoryPropsBuilder);
			const propsInfo = propsBuilder.getProps({
				priority: 1,
				endpoint,
				location: ChatLocation.Agent,
				promptContext,
				maxToolResultLength: Infinity,
			});

			const progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart> = {
				report: value => {
					if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
						stream.progress(value.message);
					}
				}
			};

			stream.progress(l10n.t('Summarizing conversation history...'));

			const renderer = PromptRenderer.create(this.instantiationService, endpoint, SummarizedConversationHistory, {
				...propsInfo.props,
				triggerSummarize: true,
			});
			const result = await renderer.render(progress, token);
			const summaryMetadata = result.metadata.get(SummarizedConversationHistoryMetadata);
			if (!summaryMetadata) {
				stream.markdown(l10n.t('Unable to summarize conversation history.'));
				return {};
			}

			stream.markdown(l10n.t('Summarized conversation history.'));
			return {
				metadata: {
					summary: {
						toolCallRoundId: summaryMetadata.toolCallRoundId,
						text: summaryMetadata.text,
					}
				}
			};
		} catch (e) {
			if (isCancellationError(e)) {
				return {};
			}

			const message = e instanceof Error ? e.message : String(e);
			stream.markdown(l10n.t('Failed to summarize conversation history: {0}', message));
			return {};
		}
	}
}

export class AgentIntentInvocation extends EditCodeIntentInvocation implements IIntentInvocation {

	public override readonly codeblocksRepresentEdits = false;

	protected prompt: typeof AgentPrompt | typeof EditCodePrompt2 | typeof NotebookInlinePrompt = AgentPrompt;

	protected extraPromptProps: Partial<AgentPromptProps> | undefined;

	private _resolvedCustomizations: AgentPromptCustomizations | undefined;

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
		@IExperimentationService private readonly expService: IExperimentationService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService);
	}

	public override getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return this.instantiationService.invokeFunction(getAgentTools, this.request);
	}

	override async buildPrompt(
		promptContext: IBuildPromptContext,
		progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>,
		token: vscode.CancellationToken
	): Promise<IBuildPromptResult> {
		this._resolvedCustomizations = await PromptRegistry.resolveAllCustomizations(this.instantiationService, this.endpoint);
		// Add any references from the codebase invocation to the request
		const codebase = await this._getCodebaseReferences(promptContext, token);

		let variables = promptContext.chatVariables;
		let toolReferences: vscode.ChatPromptReference[] = [];
		if (codebase) {
			toolReferences = toNewChatReferences(variables, codebase.references);
			variables = new ChatVariablesCollection([...this.request.references, ...toolReferences]);
		}

		const tools = promptContext.tools?.availableTools;
		const toolTokens = tools?.length ? await this.endpoint.acquireTokenizer().countToolTokens(tools) : 0;

		const summarizeThresholdOverride = this.configurationService.getConfig<number | undefined>(ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold);
		if (typeof summarizeThresholdOverride === 'number' && summarizeThresholdOverride < 100) {
			throw new Error(`Setting github.copilot.${ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold.id} is too low`);
		}

		// Reserve extra space when tools are involved due to token counting issues
		const baseBudget = Math.min(
			this.configurationService.getConfig<number | undefined>(ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold) ?? this.endpoint.modelMaxPromptTokens,
			this.endpoint.modelMaxPromptTokens
		);
		const useTruncation = this.endpoint.apiType === 'responses' && this.configurationService.getConfig(ConfigKey.Advanced.UseResponsesApiTruncation);
		const summarizationEnabled = this.configurationService.getConfig(ConfigKey.SummarizeAgentConversationHistory) && this.prompt === AgentPrompt;

		// For Anthropic models with context editing, check previous turn's token usage to determine budget
		// 1. No token usage info (no prev turn) -> use normal safeBudget and let prompt rendering handle BudgetExceededError
		// 2. Token usage + current turn > threshold -> throw BudgetExceededError to trigger summarization
		// 3. Token usage + current turn < threshold -> use MAX_SAFE_INTEGER (no summarization needed)
		let safeBudget: number = -1;
		let shouldTriggerSummarize = false;
		const budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85);

		const anthropicContextEditingEnabled = isAnthropicContextEditingEnabled(this.endpoint, this.configurationService, this.expService);
		if (summarizationEnabled && anthropicContextEditingEnabled) {
			// First check current turn for token usage (from tool calling loop), then fall back to previous turn's result metadata
			const currentTurn = promptContext.conversation?.getLatestTurn();
			const currentTurnTokenUsage = currentTurn?.getMetadata(AnthropicTokenUsageMetadata);
			const previousTurn = promptContext.history?.at(-1);

			const promptTokens = currentTurnTokenUsage?.promptTokens ?? previousTurn?.resultMetadata?.promptTokens;
			const outputTokens = currentTurnTokenUsage?.outputTokens ?? previousTurn?.resultMetadata?.outputTokens;

			if (promptTokens !== undefined && outputTokens !== undefined) {
				// Estimate total tokens from the last completed turn (prompt + output) and add a 15% buffer to anticipate growth in the upcoming turn/tool call
				const totalEstimatedTokens = (promptTokens + outputTokens) * 1.15;

				if (totalEstimatedTokens > this.endpoint.modelMaxPromptTokens) {
					// Will exceed budget - trigger summarization
					shouldTriggerSummarize = true;
					safeBudget = budgetThreshold; // Use normal budget for the summarization render
					this.logService.debug(`AgentIntent: token usage exceeds threshold, will trigger summarization (promptTokens=${promptTokens}, outputTokens=${outputTokens}, total=${totalEstimatedTokens}, threshold=${budgetThreshold})`);
				} else {
					// Under budget - no summarization needed, use unlimited budget
					safeBudget = Number.MAX_SAFE_INTEGER;
					this.logService.debug(`AgentIntent: token usage under threshold, skipping summarization (promptTokens=${promptTokens}, outputTokens=${outputTokens}, total=${totalEstimatedTokens}, threshold=${budgetThreshold})`);
				}
			}
		}
		if (safeBudget < 0) {
			safeBudget = useTruncation ? Number.MAX_SAFE_INTEGER : budgetThreshold;
		}
		const endpoint = toolTokens > 0 ? this.endpoint.cloneWithTokenOverride(safeBudget) : this.endpoint;

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
			...this.extraPromptProps,
			customizations: this._resolvedCustomizations
		};

		// Helper function for summarization flow with fallbacks
		const renderWithSummarization = async (reason: string, renderProps: AgentPromptProps = props): Promise<RenderPromptResult> => {
			this.logService.debug(`[Agent] ${reason}, triggering summarization`);
			try {
				const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
					...renderProps,
					triggerSummarize: true,
				});
				return await renderer.render(progress, token);
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
				this.telemetryService.sendMSFTTelemetryEvent('triggerSummarizeFailed', { errorKind, model: renderProps.endpoint.model });

				// Something else went wrong, eg summarization failed, so render the prompt with no cache breakpoints, summarization, endpoint not reduced in size for tools or safety buffer
				const renderer = PromptRenderer.create(this.instantiationService, this.endpoint, this.prompt, {
					...renderProps,
					endpoint: this.endpoint,
					enableCacheBreakpoints: false
				});
				try {
					return await renderer.render(progress, token);
				} catch (e) {
					if (e instanceof BudgetExceededError) {
						this.logService.error(e, `[Agent] final render fallback failed due to budget exceeded`);
						const maxTokens = this.endpoint.modelMaxPromptTokens;
						throw new Error(`Unable to build prompt, modelMaxPromptTokens = ${maxTokens} (${e.message})`);
					}
					throw e;
				}
			}
		};

		if (shouldTriggerSummarize) {
			// Token usage from previous turn indicates we'll exceed budget - go directly to summarization flow
			result = await renderWithSummarization('token usage from previous turn exceeds budget threshold');
		} else {
			try {
				const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, props);
				result = await renderer.render(progress, token);
			} catch (e) {
				if (e instanceof BudgetExceededError && summarizationEnabled) {
					if (!promptContext.toolCallResults) {
						promptContext = {
							...promptContext,
							toolCallResults: {}
						};
					}
					e.metadata.getAll(ToolResultMetadata).forEach((metadata) => {
						promptContext.toolCallResults![metadata.toolCallId] = metadata.result;
					});
					result = await renderWithSummarization(`budget exceeded(${e.message})`);
				} else {
					throw e;
				}
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


		return {
			...result,
			// The codebase tool is not actually called/referenced in the edit prompt, so we ned to
			// merge its metadata so that its output is not lost and it's not called repeatedly every turn
			// todo@connor4312/joycerhl: this seems a bit janky
			metadata: codebase ? mergeMetadata(result.metadata, codebase.metadatas) : result.metadata,
			// Don't report file references that came in via chat variables in an editing session, unless they have warnings,
			// because they are already displayed as part of the working set
			// references: result.references.filter((ref) => this.shouldKeepReference(editCodeStep, ref, toolReferences, chatVariables)),
		};
	}

	modifyErrorDetails(errorDetails: vscode.ChatErrorDetails, response: ChatResponse): vscode.ChatErrorDetails {
		if (!errorDetails.responseIsFiltered) {
			errorDetails.confirmationButtons = [
				{ data: { copilotContinueOnError: true } satisfies IContinueOnErrorConfirmation, label: l10n.t('Try Again') },
			];
		}
		return errorDetails;
	}

	getAdditionalVariables(promptContext: IBuildPromptContext): ChatVariablesCollection | undefined {
		const lastTurn = promptContext.conversation?.turns.at(-1);
		if (!lastTurn) {
			return;
		}

		// Search backwards to find the first real request and return those variables too.
		// Variables aren't re-attached to requests from confirmations.
		// TODO https://github.com/microsoft/vscode/issues/262858, more to do here
		if (lastTurn.acceptedConfirmationData) {
			const turns = promptContext.conversation!.turns.slice(0, -1);
			for (const turn of Iterable.reverse(turns)) {
				if (!turn.acceptedConfirmationData) {
					return turn.promptVariables;
				}
			}
		}
	}

	override processResponse = undefined;
}
