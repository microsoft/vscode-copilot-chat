/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw, RenderPromptResult } from '@vscode/prompt-tsx';
import { BudgetExceededError } from '@vscode/prompt-tsx/dist/base/materialized';
import type * as vscode from 'vscode';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isAnthropicFamily, isGptFamily, modelCanUseApplyPatchExclusively, modelCanUseReplaceStringExclusively, modelSupportsApplyPatch, modelSupportsMultiReplaceString, modelSupportsReplaceString, modelSupportsSimplifiedApplyPatchInstructions } from '../../../platform/endpoint/common/chatModelCapabilities';
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

import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';

import { ChatResponseProgressPart2 } from '../../../vscodeTypes';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, normalizeSummariesOnRounds, RenderedUserMessageMetadata, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { getRequestedToolCallIterationLimit, IContinueOnErrorConfirmation } from '../../prompt/common/specialRequestTypes';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IBuildPromptResult, IIntent, IIntentInvocation } from '../../prompt/node/intents';
import { AgentPrompt, AgentPromptProps } from '../../prompts/node/agent/agentPrompt';
import { BackgroundSummarizationState, BackgroundSummarizer } from '../../prompts/node/agent/backgroundSummarizer';
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

	private readonly _backgroundSummarizers = new Map<string, BackgroundSummarizer>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IChatSessionService chatSessionService: IChatSessionService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { intentInvocation: AgentIntentInvocation, processCodeblocks: false });
		chatSessionService.onDidDisposeChatSession(sessionId => {
			const summarizer = this._backgroundSummarizers.get(sessionId);
			if (summarizer) {
				summarizer.cancel();
				this._backgroundSummarizers.delete(sessionId);
			}
		});
	}

	getOrCreateBackgroundSummarizer(sessionId: string, modelMaxPromptTokens: number): BackgroundSummarizer {
		let summarizer = this._backgroundSummarizers.get(sessionId);
		if (!summarizer) {
			summarizer = new BackgroundSummarizer(modelMaxPromptTokens);
			this._backgroundSummarizers.set(sessionId, summarizer);
		}
		return summarizer;
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
		yieldRequested: () => boolean
	): Promise<vscode.ChatResult> {
		if (request.command === 'compact') {
			return this.handleSummarizeCommand(conversation, request, stream, token);
		}

		return super.handleRequest(conversation, request, stream, token, documentContext, agentName, location, chatTelemetry, yieldRequested);
	}

	private async handleSummarizeCommand(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		normalizeSummariesOnRounds(conversation.turns);

		// Exclude the current /compact turn.
		const history = conversation.turns.slice(0, -1);
		if (history.length === 0) {
			stream.markdown(l10n.t('Nothing to compact. Start a conversation first.'));
			return {};
		}

		// The summarization metadata needs to be associated with a tool call round.
		const lastRoundId = history.at(-1)?.rounds.at(-1)?.id;
		if (!lastRoundId) {
			stream.markdown(l10n.t('Nothing to compact. Start a conversation with tool calls first.'));
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

			stream.progress(l10n.t('Compacting conversation...'));

			const progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart> = {
				report: () => { }
			};
			const renderer = PromptRenderer.create(this.instantiationService, endpoint, SummarizedConversationHistory, {
				...propsInfo.props,
				triggerSummarize: true,
				summarizationInstructions: request.prompt || undefined,
			});
			const result = await renderer.render(progress, token);
			const summaryMetadata = result.metadata.get(SummarizedConversationHistoryMetadata);
			if (!summaryMetadata) {
				stream.markdown(l10n.t('Unable to compact conversation.'));
				return {};
			}

			if (summaryMetadata.usage) {
				stream.usage({
					promptTokens: summaryMetadata.usage.prompt_tokens,
					completionTokens: summaryMetadata.usage.completion_tokens,
					promptTokenDetails: summaryMetadata.promptTokenDetails,
				});
			}

			stream.markdown(l10n.t('Compacted conversation.'));
			const lastTurn = conversation.getLatestTurn();

			const chatResult: vscode.ChatResult = {
				metadata: {
					summary: {
						toolCallRoundId: summaryMetadata.toolCallRoundId,
						text: summaryMetadata.text,
					}
				}
			};

			// setResponse must be called so that turn.resultMetadata?.summary
			// is available for normalizeSummariesOnRounds on subsequent turns.
			lastTurn.setResponse(
				TurnStatus.Success,
				{ type: 'model', message: '' },
				undefined,
				chatResult,
			);

			lastTurn.setMetadata(summaryMetadata);

			return chatResult;
		} catch (e) {
			if (isCancellationError(e)) {
				return {};
			}

			const message = e instanceof Error ? e.message : String(e);
			stream.markdown(l10n.t('Failed to compact conversation: {0}', message));
			return {};
		}
	}
}

export class AgentIntentInvocation extends EditCodeIntentInvocation implements IIntentInvocation {

	public override readonly codeblocksRepresentEdits = false;

	protected prompt: typeof AgentPrompt | typeof EditCodePrompt2 | typeof NotebookInlinePrompt = AgentPrompt;

	protected extraPromptProps: Partial<AgentPromptProps> | undefined;

	private _resolvedCustomizations: AgentPromptCustomizations | undefined;

	private _lastRenderTokenCount: number = 0;

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
		const backgroundCompactionEnabled = summarizationEnabled && this.configurationService.getExperimentBasedConfig(ConfigKey.BackgroundCompaction, this.expService);

		const budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85);
		const safeBudget = useTruncation ? Number.MAX_SAFE_INTEGER : budgetThreshold;
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

		// ── Background compaction: dual-threshold approach ────────────────
		//
		// Background compaction thresholds (checked post-render using the
		// actual tokenCount from the current render):
		//
		//   Completed (previous bg pass)  → apply the summary before rendering.
		//
		//   ≥ 95% + InProgress             → block on the background compaction
		//                                    completing, then apply before rendering.
		//
		//   ≥ 75% + Idle (post-render)     → kick off background compaction so
		//                                    it is ready for a future iteration.
		//
		const backgroundSummarizer = backgroundCompactionEnabled ? this._getOrCreateBackgroundSummarizer(promptContext.conversation?.sessionId) : undefined;
		const contextRatio = backgroundSummarizer && budgetThreshold > 0
			? this._lastRenderTokenCount / budgetThreshold
			: 0;

		// Track whether we applied a summary in this iteration so we don't
		// immediately re-trigger background compaction in the post-render check.
		let summaryAppliedThisIteration = false;

		// 1. If a previous background pass completed, apply its summary now.
		if (backgroundCompactionEnabled && backgroundSummarizer?.state === BackgroundSummarizationState.Completed) {
			const bgResult = backgroundSummarizer.consumeAndReset();
			if (bgResult) {
				this.logService.debug(`[Agent] applying completed background summary (roundId=${bgResult.toolCallRoundId})`);
				this._applySummaryToRounds(bgResult, promptContext);
				this._persistSummaryOnTurn(bgResult, promptContext);
				summaryAppliedThisIteration = true;
			}
		}

		// 2. At ≥ 95% — block and wait for the in-progress compaction,
		//    then apply the result before rendering.
		if (backgroundCompactionEnabled && backgroundSummarizer && contextRatio >= 0.95 && backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
			this.logService.debug(`[Agent] context at ${(contextRatio * 100).toFixed(0)}% — blocking on background compaction`);
			const summaryPromise = backgroundSummarizer.waitForCompletion();
			progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
				try { await summaryPromise; } catch { }
				return l10n.t('Compacted conversation');
			}));
			await summaryPromise;
			const bgResult = backgroundSummarizer.consumeAndReset();
			if (bgResult) {
				this.logService.debug(`[Agent] background compaction completed — applying result (roundId=${bgResult.toolCallRoundId})`);
				this._applySummaryToRounds(bgResult, promptContext);
				this._persistSummaryOnTurn(bgResult, promptContext);
				summaryAppliedThisIteration = true;
			} else {
				this.logService.debug(`[Agent] background compaction finished but produced no usable result`);
			}
		}

		// Helper function for synchronous summarization flow with fallbacks
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

				// If a background compaction is already running or completed,
				// wait for / apply it instead of firing another LLM request.
				if (backgroundSummarizer && (backgroundSummarizer.state === BackgroundSummarizationState.InProgress || backgroundSummarizer.state === BackgroundSummarizationState.Completed)) {
					if (backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
						this.logService.debug(`[Agent] budget exceeded — waiting on in-progress background compaction instead of new request`);
						const summaryPromise = backgroundSummarizer.waitForCompletion();
						progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
							try { await summaryPromise; } catch { }
							return l10n.t('Compacted conversation');
						}));
						await summaryPromise;
					} else {
						this.logService.debug(`[Agent] budget exceeded — applying already-completed background compaction`);
					}
					const bgResult = backgroundSummarizer.consumeAndReset();
					if (bgResult) {
						this.logService.debug(`[Agent] background compaction applied after budget exceeded (roundId=${bgResult.toolCallRoundId})`);
						this._applySummaryToRounds(bgResult, promptContext);
						this._persistSummaryOnTurn(bgResult, promptContext);
						summaryAppliedThisIteration = true;
						// Re-render with the compacted history
						const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, props);
						result = await renderer.render(progress, token);
					} else {
						this.logService.debug(`[Agent] background compaction produced no usable result after budget exceeded — falling back to synchronous summarization`);
						// Background compaction failed — fall back to synchronous summarization
						result = await renderWithSummarization(`budget exceeded(${e.message}), background compaction failed`);
					}
				} else {
					result = await renderWithSummarization(`budget exceeded(${e.message})`);
				}
			} else {
				throw e;
			}
		}

		this._lastRenderTokenCount = result.tokenCount;

		// 3. Post-render background compaction checks.
		if (backgroundCompactionEnabled && backgroundSummarizer && !summaryAppliedThisIteration) {
			const postRenderRatio = budgetThreshold > 0
				? result.tokenCount / budgetThreshold
				: 0;

			if (postRenderRatio >= 0.95 && backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
				// At ≥ 95% with a background compaction already running — wait
				// for it and apply the result so the next iteration benefits immediately.
				this.logService.debug(`[Agent] post-render at ${(postRenderRatio * 100).toFixed(0)}% — waiting on in-progress background compaction`);
				const summaryPromise = backgroundSummarizer.waitForCompletion();
				progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
					try { await summaryPromise; } catch { }
					return l10n.t('Compacted conversation');
				}));
				await summaryPromise;
				const bgResult = backgroundSummarizer.consumeAndReset();
				if (bgResult) {
					this.logService.debug(`[Agent] post-render background compaction completed — applying result (roundId=${bgResult.toolCallRoundId})`);
					this._applySummaryToRounds(bgResult, promptContext);
					this._persistSummaryOnTurn(bgResult, promptContext);
				} else {
					this.logService.debug(`[Agent] post-render background compaction finished but produced no usable result`);
				}
			} else if (postRenderRatio >= 0.75 && (backgroundSummarizer.state === BackgroundSummarizationState.Idle || backgroundSummarizer.state === BackgroundSummarizationState.Failed)) {
				// At ≥ 75% with no running compaction (or a previous failure) — kick off background work.
				this._startBackgroundSummarization(backgroundSummarizer, props, endpoint, token, postRenderRatio);
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

	private _startBackgroundSummarization(
		backgroundSummarizer: BackgroundSummarizer,
		props: AgentPromptProps,
		endpoint: IChatEndpoint,
		token: vscode.CancellationToken,
		contextRatio: number,
	): void {
		this.logService.debug(`[Agent] context at ${(contextRatio * 100).toFixed(0)}% — starting background compaction`);
		const snapshotProps: AgentPromptProps = { ...props, promptContext: { ...props.promptContext } };
		const bgRenderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
			...snapshotProps,
			triggerSummarize: true,
		});
		const bgProgress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart> = { report: () => { } };
		backgroundSummarizer.start(async () => {
			try {
				const bgRenderResult = await bgRenderer.render(bgProgress, token);
				const summaryMetadata = bgRenderResult.metadata.get(SummarizedConversationHistoryMetadata);
				if (!summaryMetadata) {
					throw new Error('Background compaction produced no summary metadata');
				}
				this.logService.debug(`[Agent] background compaction completed successfully (roundId=${summaryMetadata.toolCallRoundId})`);
				return { summary: summaryMetadata.text, toolCallRoundId: summaryMetadata.toolCallRoundId };
			} catch (err) {
				this.logService.error(err, `[Agent] background compaction failed`);
				throw err;
			}
		});
	}

	/**
	 * Returns the `BackgroundSummarizer` for this session, or `undefined` if
	 * the intent is not an `AgentIntent` (e.g. `AskAgentIntent`).
	 */
	private _getOrCreateBackgroundSummarizer(sessionId: string | undefined): BackgroundSummarizer | undefined {
		if (!sessionId || !(this.intent instanceof AgentIntent)) {
			return undefined;
		}
		return this.intent.getOrCreateBackgroundSummarizer(sessionId, this.endpoint.modelMaxPromptTokens);
	}

	/**
	 * Apply a background-compaction result onto the in-memory rounds so
	 * that the next render picks up the `<conversation-summary>` element.
	 */
	private _applySummaryToRounds(bgResult: { summary: string; toolCallRoundId: string }, promptContext: IBuildPromptContext): void {
		// Check current-turn rounds first
		const currentRound = promptContext.toolCallRounds?.find(r => r.id === bgResult.toolCallRoundId);
		if (currentRound) {
			currentRound.summary = bgResult.summary;
			return;
		}
		// Fall back to history turns
		for (const turn of [...promptContext.history].reverse()) {
			const round = turn.rounds.find(r => r.id === bgResult.toolCallRoundId);
			if (round) {
				round.summary = bgResult.summary;
				return;
			}
		}
	}

	/**
	 * Persist the summary on the current turn's `resultMetadata` so that
	 * `normalizeSummariesOnRounds` restores it on subsequent turns.
	 */
	private _persistSummaryOnTurn(bgResult: { summary: string; toolCallRoundId: string }, promptContext: IBuildPromptContext): void {
		const chatResult = promptContext.conversation?.getLatestTurn().responseChatResult;
		if (chatResult) {
			const metadata = (chatResult.metadata ?? {}) as Record<string, unknown>;
			metadata['summary'] = { toolCallRoundId: bgResult.toolCallRoundId, text: bgResult.summary };
			(chatResult as { metadata: unknown }).metadata = metadata;
		}
	}

	override processResponse = undefined;
}
