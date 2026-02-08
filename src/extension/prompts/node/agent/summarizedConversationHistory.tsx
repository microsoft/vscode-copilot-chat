/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PrioritizedList, PromptElement, PromptMetadata, PromptSizing, Raw, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { BudgetExceededError } from '@vscode/prompt-tsx/dist/base/materialized';
import { ChatMessage } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { ChatResponsePart, LanguageModelToolInformation, NotebookDocument, Progress } from 'vscode';
import { IChatHookService, PreCompactHookInput } from '../../../../platform/chat/common/chatHookService';
import { ChatFetchResponseType, ChatLocation, ChatResponse, FetchSuccess } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { isAnthropicFamily } from '../../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { APIUsage } from '../../../../platform/networking/common/openai';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { ThinkingData } from '../../../../platform/thinking/common/thinking';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError, isCancellationError } from '../../../../util/vs/base/common/errors';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart2 } from '../../../../vscodeTypes';
import { addCacheBreakpoints } from '../../../intents/node/cacheBreakpoints';
import { ToolCallingLoop } from '../../../intents/node/toolCallingLoop';
import { IResultMetadata } from '../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCallRound } from '../../../prompt/common/intents';
import { ToolName } from '../../../tools/common/toolNames';
import { normalizeToolSchema } from '../../../tools/common/toolSchemaNormalizer';
import { NotebookSummary } from '../../../tools/node/notebookSummaryTool';
import { renderPromptElement } from '../base/promptRenderer';
import { Tag } from '../base/tag';
import { ChatToolCalls } from '../panel/toolCalling';
import { AgentPrompt, AgentPromptProps, AgentUserMessage, AgentUserMessageCustomizations, getUserMessagePropsFromAgentProps, getUserMessagePropsFromTurn } from './agentPrompt';
import { DefaultOpenAIKeepGoingReminder } from './openai/defaultOpenAIPrompt';
import { SimpleSummarizedHistory } from './simpleSummarizedHistoryPrompt';

export interface ConversationHistorySummarizationPromptProps extends SummarizedAgentHistoryProps {
	readonly simpleMode?: boolean;
}

const SummaryPrompt = <>
	Your task is to create a comprehensive, detailed summary of the entire conversation that captures all essential information needed to seamlessly continue the work without any loss of context. This summary will be used to compact the conversation while preserving critical technical details, decisions, and progress.<br />

	## Recent Context Analysis<br />

	Pay special attention to the most recent agent commands and tool executions that led to this summarization being triggered. Include:<br />
	- **Last Agent Commands**: What specific actions/tools were just executed<br />
	- **Tool Results**: Key outcomes from recent tool calls (truncate if very long, but preserve essential information)<br />
	- **Immediate State**: What was the system doing right before summarization<br />
	- **Triggering Context**: What caused the token budget to be exceeded<br />

	## Analysis Process<br />

	Before providing your final summary, wrap your analysis in `&lt;analysis&gt;` tags to organize your thoughts systematically:<br />

	1. **Chronological Review**: Go through the conversation chronologically, identifying key phases and transitions<br />
	2. **Intent Mapping**: Extract all explicit and implicit user requests, goals, and expectations<br />
	3. **Technical Inventory**: Catalog all technical concepts, tools, frameworks, and architectural decisions<br />
	4. **Code Archaeology**: Document all files, functions, and code patterns that were discussed or modified<br />
	5. **Progress Assessment**: Evaluate what has been completed vs. what remains pending<br />
	6. **Context Validation**: Ensure all critical information for continuation is captured<br />
	7. **Recent Commands Analysis**: Document the specific agent commands and tool results from the most recent operations<br />

	## Summary Structure<br />

	Your summary must include these sections in order, following the exact format below:<br />

	<Tag name='analysis'>
		[Chronological Review: Walk through conversation phases: initial request → exploration → implementation → debugging → current state]<br />
		[Intent Mapping: List each explicit user request with message context]<br />
		[Technical Inventory: Catalog all technologies, patterns, and decisions mentioned]<br />
		[Code Archaeology: Document every file, function, and code change discussed]<br />
		[Progress Assessment: What's done vs. pending with specific status]<br />
		[Context Validation: Verify all continuation context is captured]<br />
		[Recent Commands Analysis: Last agent commands executed, tool results (truncated if long), immediate pre-summarization state]<br />
	</Tag><br />

	<Tag name='summary'>
		1. Conversation Overview:<br />
		- Primary Objectives: [All explicit user requests and overarching goals with exact quotes]<br />
		- Session Context: [High-level narrative of conversation flow and key phases]<br />
		- User Intent Evolution: [How user's needs or direction changed throughout conversation]<br />

		2. Technical Foundation:<br />
		- [Core Technology 1]: [Version/details and purpose]<br />
		- [Framework/Library 2]: [Configuration and usage context]<br />
		- [Architectural Pattern 3]: [Implementation approach and reasoning]<br />
		- [Environment Detail 4]: [Setup specifics and constraints]<br />

		3. Codebase Status:<br />
		- [File Name 1]:<br />
		- Purpose: [Why this file is important to the project]<br />
		- Current State: [Summary of recent changes or modifications]<br />
		- Key Code Segments: [Important functions/classes with brief explanations]<br />
		- Dependencies: [How this relates to other components]<br />
		- [File Name 2]:<br />
		- Purpose: [Role in the project]<br />
		- Current State: [Modification status]<br />
		- Key Code Segments: [Critical code blocks]<br />
		- [Additional files as needed]<br />

		4. Problem Resolution:<br />
		- Issues Encountered: [Technical problems, bugs, or challenges faced]<br />
		- Solutions Implemented: [How problems were resolved and reasoning]<br />
		- Debugging Context: [Ongoing troubleshooting efforts or known issues]<br />
		- Lessons Learned: [Important insights or patterns discovered]<br />

		5. Progress Tracking:<br />
		- Completed Tasks: [What has been successfully implemented with status indicators]<br />
		- Partially Complete Work: [Tasks in progress with current completion status]<br />
		- Validated Outcomes: [Features or code confirmed working through testing]<br />

		6. Active Work State:<br />
		- Current Focus: [Precisely what was being worked on in most recent messages]<br />
		- Recent Context: [Detailed description of last few conversation exchanges]<br />
		- Working Code: [Code snippets being modified or discussed recently]<br />
		- Immediate Context: [Specific problem or feature being addressed before summary]<br />

		7. Recent Operations:<br />
		- Last Agent Commands: [Specific tools/actions executed just before summarization with exact command names]<br />
		- Tool Results Summary: [Key outcomes from recent tool executions - truncate long results but keep essential info]<br />
		- Pre-Summary State: [What the agent was actively doing when token budget was exceeded]<br />
		- Operation Context: [Why these specific commands were executed and their relationship to user goals]<br />

		8. Continuation Plan:<br />
		- [Pending Task 1]: [Details and specific next steps with verbatim quotes]<br />
		- [Pending Task 2]: [Requirements and continuation context]<br />
		- [Priority Information]: [Which tasks are most urgent or logically sequential]<br />
		- [Next Action]: [Immediate next step with direct quotes from recent messages]<br />
	</Tag><br />

	## Quality Guidelines<br />

	- **Precision**: Include exact filenames, function names, variable names, and technical terms<br />
	- **Completeness**: Capture all context needed to continue without re-reading the full conversation<br />
	- **Clarity**: Write for someone who needs to pick up exactly where the conversation left off<br />
	- **Verbatim Accuracy**: Use direct quotes for task specifications and recent work context<br />
	- **Technical Depth**: Include enough detail for complex technical decisions and code patterns<br />
	- **Logical Flow**: Present information in a way that builds understanding progressively<br />

	This summary should serve as a comprehensive handoff document that enables seamless continuation of all active work streams while preserving the full technical and contextual richness of the original conversation.<br />
</>;

/**
 * Prompt used to summarize conversation history when the context window is exceeded.
 */
export class ConversationHistorySummarizationPrompt extends PromptElement<ConversationHistorySummarizationPromptProps> {
	override async render(state: void, sizing: PromptSizing) {
		const history = this.props.simpleMode ?
			<SimpleSummarizedHistory priority={1} promptContext={this.props.promptContext} location={this.props.location} endpoint={this.props.endpoint} maxToolResultLength={this.props.maxToolResultLength} /> :
			<ConversationHistory priority={1} promptContext={this.props.promptContext} location={this.props.location} endpoint={this.props.endpoint} maxToolResultLength={this.props.maxToolResultLength} enableCacheBreakpoints={this.props.enableCacheBreakpoints} />;
		const isOpus = this.props.endpoint.model.startsWith('claude-opus');
		return (
			<>
				<SystemMessage priority={this.props.priority}>
					{SummaryPrompt}
				</SystemMessage>
				{history}
				{this.props.workingNotebook && <WorkingNotebookSummary priority={this.props.priority - 2} notebook={this.props.workingNotebook} />}
				<UserMessage>
					Summarize the conversation history so far, paying special attention to the most recent agent commands and tool results that triggered this summarization. Structure your summary using the enhanced format provided in the system message.<br />
					{isOpus && <>
						<br />
						IMPORTANT: Do NOT call any tools. Your only task is to generate a text summary of the conversation. Do not attempt to execute any actions or make any tool calls.<br />
					</>}
					Focus particularly on:<br />
					- The specific agent commands/tools that were just executed<br />
					- The results returned from these recent tool calls (truncate if very long but preserve key information)<br />
					- What the agent was actively working on when the token budget was exceeded<br />
					- How these recent operations connect to the overall user goals<br />

					Include all important tool calls and their results as part of the appropriate sections, with special emphasis on the most recent operations.
				</UserMessage>
			</>
		);
	}
}

class WorkingNotebookSummary extends PromptElement<NotebookSummaryProps> {
	override async render(state: void, sizing: PromptSizing) {
		return (
			<UserMessage>
				This is the current state of the notebook that you have been working on:<br />
				<NotebookSummary notebook={this.props.notebook} includeCellLines={false} altDoc={undefined} />
			</UserMessage>
		);
	}
}

export interface NotebookSummaryProps extends BasePromptElementProps {
	readonly notebook: NotebookDocument;
}

/**
 * Conversation history rendered with tool calls and summaries.
 */
class ConversationHistory extends PromptElement<SummarizedAgentHistoryProps> {
	override async render(state: void, sizing: PromptSizing) {
		// Iterate over the turns in reverse order until we find a turn with a tool call round that was summarized
		const history: PromptElement[] = [];

		// If we have a stop hook query, add it as a new user message at the very end of the conversation.
		// Push it first so that after history.reverse() it will be last.
		if (this.props.promptContext.hasStopHookQuery) {
			history.push(<UserMessage priority={901}>{this.props.promptContext.query}</UserMessage>);
		}

		// Handle the possibility that we summarized partway through the current turn (e.g. if we accumulated many tool call rounds)
		let summaryForCurrentTurn: string | undefined = undefined;
		let thinkingForFirstRoundAfterSummarization: ThinkingData | undefined = undefined;
		if (this.props.promptContext.toolCallRounds?.length) {
			const toolCallRounds: IToolCallRound[] = [];
			for (let i = this.props.promptContext.toolCallRounds.length - 1; i >= 0; i--) {
				const toolCallRound = this.props.promptContext.toolCallRounds[i];
				if (toolCallRound.summary) {
					// This tool call round was summarized
					summaryForCurrentTurn = toolCallRound.summary;
					thinkingForFirstRoundAfterSummarization = toolCallRound.thinking;
					break;
				}
				toolCallRounds.push(toolCallRound);
			}

			// Reverse the tool call rounds so they are in chronological order
			toolCallRounds.reverse();

			// For Anthropic models with thinking enabled, set the thinking on the first round
			// so it gets rendered as the first thinking block after summarization
			if (isAnthropicFamily(this.props.endpoint) && thinkingForFirstRoundAfterSummarization && toolCallRounds.length > 0 && !toolCallRounds[0].thinking) {
				toolCallRounds[0].thinking = thinkingForFirstRoundAfterSummarization;
			}

			history.push(<ChatToolCalls priority={899} flexGrow={2} promptContext={this.props.promptContext} toolCallRounds={toolCallRounds} toolCallResults={this.props.promptContext.toolCallResults} enableCacheBreakpoints={this.props.enableCacheBreakpoints} truncateAt={this.props.maxToolResultLength} />);
		}

		if (summaryForCurrentTurn) {
			history.push(<SummaryMessageElement endpoint={this.props.endpoint} summaryText={summaryForCurrentTurn} />);

			return (<PrioritizedList priority={this.props.priority} descending={false} passPriority={true}>
				{history.reverse()}
			</PrioritizedList>);
		}

		// Render the original user message:
		// - Always render for non-continuation (normal first iteration)
		// - Also render for stop hook continuation (the original message is needed, frozen content will provide it)
		if (!this.props.promptContext.isContinuation || this.props.promptContext.hasStopHookQuery) {
			history.push(<AgentUserMessage flexGrow={2} priority={900} {...getUserMessagePropsFromAgentProps(this.props, {
				userQueryTagName: this.props.userQueryTagName,
				ReminderInstructionsClass: this.props.ReminderInstructionsClass,
				ToolReferencesHintClass: this.props.ToolReferencesHintClass,
			})} />);
		}

		// We may have a summary from earlier in the conversation, but skip history if we have a new summary
		for (const [i, turn] of [...this.props.promptContext.history.entries()].reverse()) {
			const metadata = turn.resultMetadata;

			// Build this list in chronological order
			const turnComponents: PromptElement[] = [];

			// Turn anatomy
			// ______________
			// |            |
			// |    USER    |
			// |            |
			// |  ASSISTANT |
			// |            |
			// |    TOOL    | <-- { summary: ..., toolCallRoundId: ... }
			// |  ASSISTANT |
			// |____________|

			let summaryForTurn: SummarizedConversationHistoryMetadata | undefined;
			// If a tool call limit is exceeded, the tool call from this turn will
			// have been aborted and any result should be found in the next turn.
			const toolCallResultInNextTurn = metadata?.maxToolCallsExceeded;
			let toolCallResults = metadata?.toolCallResults;
			if (toolCallResultInNextTurn) {
				const nextMetadata = this.props.promptContext.history.at(i + 1)?.responseChatResult?.metadata as IResultMetadata | undefined;
				const mergeFrom = i === this.props.promptContext.history.length - 1 ? this.props.promptContext.toolCallResults : nextMetadata?.toolCallResults;
				toolCallResults = { ...toolCallResults, ...mergeFrom };
			}

			// Find the latest tool call round that was summarized
			const toolCallRounds: IToolCallRound[] = [];
			for (let i = turn.rounds.length - 1; i >= 0; i--) {
				const round = turn.rounds[i];
				summaryForTurn = round.summary ? new SummarizedConversationHistoryMetadata(round.id, round.summary) : undefined;
				if (summaryForTurn) {
					break;
				}
				toolCallRounds.push(round);
			}

			if (summaryForTurn) {
				// We have a summary for a tool call round that was part of this turn
				turnComponents.push(<SummaryMessageElement endpoint={this.props.endpoint} summaryText={summaryForTurn.text} />);
			} else if (!turn.isContinuation) {
				turnComponents.push(<AgentUserMessage flexGrow={1} {...getUserMessagePropsFromTurn(turn, this.props.endpoint, {
					userQueryTagName: this.props.userQueryTagName,
					ReminderInstructionsClass: this.props.ReminderInstructionsClass,
					ToolReferencesHintClass: this.props.ToolReferencesHintClass,
				})} />);
			}

			// Reverse the tool call rounds so they are in chronological order
			toolCallRounds.reverse();
			turnComponents.push(<ChatToolCalls
				flexGrow={1}
				promptContext={this.props.promptContext}
				toolCallRounds={toolCallRounds}
				toolCallResults={toolCallResults}
				isHistorical={!(toolCallResultInNextTurn && i === this.props.promptContext.history.length - 1)}
				truncateAt={this.props.maxToolResultLength}
			/>);

			history.push(...turnComponents.reverse());
			if (summaryForTurn) {
				// All preceding turns are covered by the summary and shouldn't be included verbatim
				break;
			}
		}

		return (<PrioritizedList priority={this.props.priority} descending={false} passPriority={true}>
			{history.reverse()}
		</PrioritizedList>);
	}
}

export class SummarizedConversationHistoryMetadata extends PromptMetadata {
	constructor(
		public readonly toolCallRoundId: string,
		public readonly text: string,
		public readonly thinking?: ThinkingData
	) {
		super();
	}
}

export interface SummarizedAgentHistoryProps extends BasePromptElementProps, AgentUserMessageCustomizations {
	readonly priority: number;
	readonly endpoint: IChatEndpoint;
	readonly location: ChatLocation;
	readonly promptContext: IBuildPromptContext;
	readonly triggerSummarize?: boolean;
	readonly tools?: ReadonlyArray<LanguageModelToolInformation> | undefined;
	readonly enableCacheBreakpoints?: boolean;
	readonly workingNotebook?: NotebookDocument;
	readonly maxToolResultLength: number;
	/** Optional hard cap on summary tokens; effective budget = min(prompt sizing tokenBudget, this value) */
	readonly maxSummaryTokens?: number;
}

/**
 * Renders conversation history with tool calls and summaries, triggering summarization while rendering if necessary.
 */
export class SummarizedConversationHistory extends PromptElement<SummarizedAgentHistoryProps> {
	constructor(
		props: SummarizedAgentHistoryProps,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing, progress: Progress<ChatResponsePart> | undefined, token: CancellationToken | undefined) {
		const promptContext = { ...this.props.promptContext };
		let historyMetadata: SummarizedConversationHistoryMetadata | undefined;
		if (this.props.triggerSummarize) {
			const summarizer = this.instantiationService.createInstance(ConversationHistorySummarizer, this.props, sizing, progress, token);
			const summResult = await summarizer.summarizeHistory();
			if (summResult) {
				historyMetadata = new SummarizedConversationHistoryMetadata(summResult.toolCallRoundId, summResult.summary, summResult.thinking);
				this.addSummaryToHistory(summResult.summary, summResult.toolCallRoundId, summResult.thinking);
			}
		}

		return <>
			{historyMetadata && <meta value={historyMetadata} />}
			<ConversationHistory
				{...this.props}
				promptContext={promptContext}
				enableCacheBreakpoints={this.props.enableCacheBreakpoints} />
		</>;
	}

	private addSummaryToHistory(summary: string, toolCallRoundId: string, thinking?: ThinkingData): void {
		const round = this.props.promptContext.toolCallRounds?.find(round => round.id === toolCallRoundId);
		if (round) {
			round.summary = summary;
			round.thinking = thinking;
			return;
		}

		// Adding summaries to rounds in previous turns will only be persisted during the current session.
		// For the next turn, need to restore them from metadata (see normalizeSummariesOnRounds).
		for (const turn of [...this.props.promptContext.history].reverse()) {
			const round = turn.rounds.find(round => round.id === toolCallRoundId);
			if (round) {
				round.summary = summary;
				round.thinking = thinking;
				break;
			}
		}
	}
}

enum SummaryMode {
	Simple = 'simple',
	Full = 'full'
}

class ConversationHistorySummarizer {
	private readonly summarizationId = generateUuid();

	constructor(
		private readonly props: SummarizedAgentHistoryProps,
		private readonly sizing: PromptSizing,
		private readonly progress: Progress<ChatResponsePart> | undefined,
		private readonly token: CancellationToken | undefined,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IChatHookService private readonly chatHookService: IChatHookService,
	) { }

	async summarizeHistory(): Promise<{ summary: string; toolCallRoundId: string; thinking?: ThinkingData }> {
		// Execute pre-compact hook before summarization to allow hooks to archive transcripts or perform cleanup
		await this.executePreCompactHook();

		// Just a function for test to create props and call this
		const propsInfo = this.instantiationService.createInstance(SummarizedConversationHistoryPropsBuilder).getProps(this.props);

		const summaryPromise = this.getSummaryWithFallback(propsInfo);
		this.progress?.report(new ChatResponseProgressPart2(l10n.t('Summarizing conversation history...'), async () => {
			try {
				await summaryPromise;
			} catch { }
			return l10n.t('Summarized conversation history');
		}));

		const summary = await summaryPromise;
		return {
			summary: summary.value,
			toolCallRoundId: propsInfo.summarizedToolCallRoundId,
			thinking: propsInfo.summarizedThinking
		};
	}

	private async getSummaryWithFallback(propsInfo: ISummarizedConversationHistoryInfo): Promise<FetchSuccess<string>> {
		const forceMode = this.configurationService.getConfig<string | undefined>(ConfigKey.Advanced.AgentHistorySummarizationMode);
		if (forceMode === SummaryMode.Simple) {
			return await this.getSummary(SummaryMode.Simple, propsInfo);
		} else {
			try {
				return await this.getSummary(SummaryMode.Full, propsInfo);
			} catch (e) {
				if (isCancellationError(e)) {
					throw e;
				}

				return await this.getSummary(SummaryMode.Simple, propsInfo);
			}
		}
	}

	private logInfo(message: string, mode: SummaryMode): void {
		this.logService.info(`[ConversationHistorySummarizer] [${mode}] ${message}`);
	}

	/**
	 * Executes the PreCompact hook before summarization starts.
	 * This gives hook scripts a chance to archive the transcript or perform cleanup
	 * before the conversation is compacted.
	 */
	private async executePreCompactHook(): Promise<void> {
		const toolInvocationToken = this.props.promptContext.tools?.toolInvocationToken;
		if (!toolInvocationToken) {
			return;
		}

		try {
			const results = await this.chatHookService.executeHook('PreCompact', {
				toolInvocationToken,
				input: {
					trigger: 'auto',
				} satisfies PreCompactHookInput
			}, this.props.promptContext.conversation?.sessionId, this.token ?? CancellationToken.None);

			for (const result of results) {
				if (result.resultKind === 'error') {
					const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
					this.logService.error(`[ConversationHistorySummarizer] PreCompact hook error: ${errorMessage}`);
				}
			}
		} catch (error) {
			this.logService.error('[ConversationHistorySummarizer] Error executing PreCompact hook', error);
		}
	}

	private async getSummary(mode: SummaryMode, propsInfo: ISummarizedConversationHistoryInfo): Promise<FetchSuccess<string>> {
		const stopwatch = new StopWatch(false);
		const forceGpt41 = this.configurationService.getExperimentBasedConfig(ConfigKey.Advanced.AgentHistorySummarizationForceGpt41, this.experimentationService);
		const gpt41Endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');
		const endpoint = forceGpt41 && (gpt41Endpoint.modelMaxPromptTokens >= this.props.endpoint.modelMaxPromptTokens) ?
			gpt41Endpoint :
			this.props.endpoint;

		let summarizationPrompt: ChatMessage[];
		const associatedRequestId = this.props.promptContext.conversation?.getLatestTurn().id;
		const promptCacheMode = this.configurationService.getExperimentBasedConfig(ConfigKey.Advanced.AgentHistorySummarizationWithPromptCache, this.experimentationService);
		try {
			if (mode === SummaryMode.Full && promptCacheMode) {
				const props: AgentPromptProps = {
					...propsInfo.props,
					triggerSummarize: false
				};
				const expandedEndpoint = endpoint.cloneWithTokenOverride(endpoint.modelMaxPromptTokens * 1.05);
				summarizationPrompt = (await renderPromptElement(this.instantiationService, expandedEndpoint, AgentPromptWithSummaryPrompt, props, undefined, this.token)).messages;
			} else {
				summarizationPrompt = (await renderPromptElement(this.instantiationService, endpoint, ConversationHistorySummarizationPrompt, { ...propsInfo.props, simpleMode: mode === SummaryMode.Simple }, undefined, this.token)).messages;
			}
			this.logInfo(`summarization prompt rendered in ${stopwatch.elapsed()}ms.`, mode);
		} catch (e) {
			const budgetExceeded = e instanceof BudgetExceededError;
			const outcome = budgetExceeded ? 'budget_exceeded' : 'renderError';
			this.logInfo(`Error rendering summarization prompt in mode: ${mode}. ${e.stack}`, mode);
			this.sendSummarizationTelemetry(outcome, '', this.props.endpoint.model, mode, stopwatch.elapsed(), undefined);
			throw e;
		}

		let summaryResponse: ChatResponse;
		try {
			const toolOpts = mode === SummaryMode.Full ? {
				tool_choice: 'none' as const,
				tools: normalizeToolSchema(
					endpoint.family,
					this.props.tools?.map(tool => ({
						function:
						{
							name: tool.name,
							description: tool.description,
							parameters: tool.inputSchema && Object.keys(tool.inputSchema).length ? tool.inputSchema : undefined
						}, type: 'function'
					})),
					(tool, rule) => {
						this.logService.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
			} : undefined;

			if (promptCacheMode) {
				addCacheBreakpoints(summarizationPrompt);
			} else {
				stripCacheBreakpoints(summarizationPrompt);
			}

			summaryResponse = await endpoint.makeChatRequest2({
				debugName: `summarizeConversationHistory-${mode}`,
				messages: ToolCallingLoop.stripInternalToolCallIds(summarizationPrompt),
				finishedCb: undefined,
				location: ChatLocation.Other,
				requestOptions: {
					temperature: 0,
					stream: false,
					...toolOpts
				},
				telemetryProperties: associatedRequestId ? { associatedRequestId } : undefined,
				enableRetryOnFilter: true
			}, this.token ?? CancellationToken.None);
		} catch (e) {
			this.logInfo(`Error from summarization request. ${e.message}`, mode);
			this.sendSummarizationTelemetry('requestThrow', '', this.props.endpoint.model, mode, stopwatch.elapsed(), undefined);
			throw e;
		}

		return this.handleSummarizationResponse(summaryResponse, mode, stopwatch.elapsed());
	}

	private async handleSummarizationResponse(response: ChatResponse, mode: SummaryMode, elapsedTime: number): Promise<FetchSuccess<string>> {
		if (response.type !== ChatFetchResponseType.Success) {
			const outcome = response.type;
			this.sendSummarizationTelemetry(outcome, response.requestId, this.props.endpoint.model, mode, elapsedTime, undefined, response.reason);
			this.logInfo(`Summarization request failed. ${response.type} ${response.reason}`, mode);
			if (response.type === ChatFetchResponseType.Canceled) {
				throw new CancellationError();
			}

			throw new Error('Summarization request failed');
		}

		const summarySize = await this.sizing.countTokens(response.value);
		const effectiveBudget =
			!!this.props.maxSummaryTokens
				? Math.min(this.sizing.tokenBudget, this.props.maxSummaryTokens)
				: this.sizing.tokenBudget;
		if (summarySize > effectiveBudget) {
			this.sendSummarizationTelemetry('too_large', response.requestId, this.props.endpoint.model, mode, elapsedTime, response.usage);
			this.logInfo(`Summary too large: ${summarySize} tokens (effective budget ${effectiveBudget})`, mode);
			throw new Error('Summary too large');
		}

		this.sendSummarizationTelemetry('success', response.requestId, this.props.endpoint.model, mode, elapsedTime, response.usage);
		return response;
	}

	/**
	 * Send telemetry for conversation summarization.
	 * @param success Whether the summarization was successful
	 */
	private sendSummarizationTelemetry(outcome: string, requestId: string, model: string, mode: SummaryMode, elapsedTime: number, usage: APIUsage | undefined, detailedOutcome?: string): void {
		const numRoundsInHistory = this.props.promptContext.history
			.map(turn => turn.rounds.length)
			.reduce((a, b) => a + b, 0);
		const numRoundsInCurrentTurn = this.props.promptContext.toolCallRounds?.length ?? 0;
		const numRounds = numRoundsInHistory + numRoundsInCurrentTurn;

		const reversedCurrentRounds = [...(this.props.promptContext.toolCallRounds ?? [])].reverse();
		let numRoundsSinceLastSummarization = reversedCurrentRounds.findIndex(round => round.summary) ?? -1;
		if (numRoundsSinceLastSummarization === -1) {
			let count = numRoundsInCurrentTurn;
			outer: for (const turn of Iterable.reverse(Array.from(this.props.promptContext.history))) {
				for (const round of Iterable.reverse(Array.from(turn.rounds ?? []))) {
					if (round.summary) {
						numRoundsSinceLastSummarization = count;
						break outer;
					}
					count++;
				}
			}
		}

		const turnIndex = this.props.promptContext.history.length;
		const curTurnRoundIndex = this.props.promptContext.toolCallRounds?.length ?? 0;

		const lastUsedTool = this.props.promptContext.toolCallRounds?.at(-1)?.toolCalls?.at(-1)?.name ??
			this.props.promptContext.history?.at(-1)?.rounds.at(-1)?.toolCalls?.at(-1)?.name ?? 'none';

		const isDuringToolCalling = !!this.props.promptContext.toolCallRounds?.length ? 1 : 0;
		const conversationId = this.props.promptContext.conversation?.sessionId;
		const hasWorkingNotebook = this.props.workingNotebook ? 1 : 0;

		/* __GDPR__
			"summarizedConversationHistory" : {
				"owner": "roblourens",
				"comment": "Tracks when summarization happens and what the outcome was",
				"summarizationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "An ID to join all attempts of this summarization task." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The success state or failure reason of the summarization." },
				"detailedOutcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "A more detailed error message." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used for the summarization." },
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The request ID from the summarization call." },
				"chatRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The chat request ID that this summarization ran during." },
				"numRounds": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of tool call rounds before this summarization was triggered." },
				"numRoundsSinceLastSummarization": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of tool call rounds since the last summarization." },
				"turnIndex": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The index of the current turn." },
				"curTurnRoundIndex": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The index of the current round within the current turn" },
				"lastUsedTool": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The name of the last tool used before summarization." },
				"isDuringToolCalling": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether this summarization was triggered during a tool calling loop." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the current chat conversation." },
				"hasWorkingNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the conversation summary includes a working notebook." },
				"mode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The mode of the conversation summary." },
				"summarizationMode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The mode of the conversation summary." },
				"duration": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The duration of the summarization attempt in ms." },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, server side counted", "isMeasurement": true },
				"promptCacheTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens hitting cache as reported by server", "isMeasurement": true },
				"responseTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of generated tokens", "isMeasurement": true }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('summarizedConversationHistory', {
			summarizationId: this.summarizationId,
			outcome,
			detailedOutcome,
			requestId,
			chatRequestId: this.props.promptContext.conversation?.getLatestTurn().id,
			model,
			lastUsedTool,
			conversationId,
			mode,
			summarizationMode: mode, // Try to unstick GDPR
		}, {
			numRounds,
			numRoundsSinceLastSummarization,
			turnIndex,
			curTurnRoundIndex,
			isDuringToolCalling,
			hasWorkingNotebook,
			duration: elapsedTime,
			promptTokenCount: usage?.prompt_tokens,
			promptCacheTokenCount: usage?.prompt_tokens_details?.cached_tokens,
			responseTokenCount: usage?.completion_tokens,
		});
	}
}

class AgentPromptWithSummaryPrompt extends PromptElement<AgentPromptProps> {
	override async render(state: void, sizing: PromptSizing) {
		return <>
			<AgentPrompt {...this.props} />
			<UserMessage>
				{SummaryPrompt}
			</UserMessage>
		</>;
	}
}

function stripCacheBreakpoints(messages: ChatMessage[]): void {
	messages.forEach(message => {
		message.content = message.content.filter(part => {
			return part.type !== Raw.ChatCompletionContentPartKind.CacheBreakpoint;
		});
	});
}

export interface ISummarizedConversationHistoryInfo {
	readonly props: SummarizedAgentHistoryProps;
	readonly summarizedToolCallRoundId: string;
	readonly summarizedThinking?: ThinkingData;
}

/**
 * Exported for test
 */
export class SummarizedConversationHistoryPropsBuilder {
	constructor(
		@IPromptPathRepresentationService private readonly _promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) { }

	getProps(
		props: SummarizedAgentHistoryProps
	): ISummarizedConversationHistoryInfo {
		let toolCallRounds = props.promptContext.toolCallRounds;
		let isContinuation = props.promptContext.isContinuation;
		let summarizedToolCallRoundId = '';
		if (toolCallRounds && toolCallRounds.length > 1) {
			// If there are multiple tool call rounds, exclude the last one, because it must have put us over the limit.
			// Summarize from the previous round in this turn.
			toolCallRounds = toolCallRounds.slice(0, -1);
			summarizedToolCallRoundId = toolCallRounds.at(-1)!.id;
		} else if (props.promptContext.history.length > 0) {
			// If there is only one tool call round, then summarize from the last round of the last turn.
			// Or if there are no tool call rounds, then the new user message put us over the limit. (or the last assistant message?)
			// This flag excludes the last user message from the summary.
			isContinuation = true;
			toolCallRounds = [];
			summarizedToolCallRoundId = props.promptContext.history.at(-1)!.rounds.at(-1)!.id;
		} else {
			throw new Error('Nothing to summarize');
		}

		// For Anthropic models with thinking enabled, find the last assistant message with thinking
		// from all rounds being summarized (both current toolCallRounds and history).
		// This thinking will be used as the first thinking block after summarization.
		const summarizedThinking = isAnthropicFamily(props.endpoint) ? this.findLastThinking(props) : undefined;
		const promptContext = {
			...props.promptContext,
			toolCallRounds,
			isContinuation,
		};
		return {
			props: {
				...props,
				workingNotebook: this.getWorkingNotebook(props),
				promptContext
			},
			summarizedToolCallRoundId,
			summarizedThinking
		};
	}

	private findLastThinking(props: SummarizedAgentHistoryProps): ThinkingData | undefined {
		if (props.promptContext.toolCallRounds) {
			for (let i = props.promptContext.toolCallRounds.length - 1; i >= 0; i--) {
				const round = props.promptContext.toolCallRounds[i];
				if (round.thinking) {
					return round.thinking;
				}
			}
		}
		return undefined;
	}

	private getWorkingNotebook(props: SummarizedAgentHistoryProps): NotebookDocument | undefined {
		const toolCallRound = props.promptContext.toolCallRounds && [...props.promptContext.toolCallRounds].reverse().find(round => round.toolCalls.some(call => call.name === ToolName.RunNotebookCell));
		const toolCall = toolCallRound?.toolCalls.find(call => call.name === ToolName.RunNotebookCell);
		if (toolCall && toolCall.arguments) {
			try {
				const args = JSON.parse(toolCall.arguments);
				if (typeof args.filePath === 'string') {
					const uri = this._promptPathRepresentationService.resolveFilePath(args.filePath);
					if (!uri) {
						return undefined;
					}
					return this._workspaceService.notebookDocuments.find(doc => doc.uri.toString() === uri.toString());
				}
			} catch (e) {
				// Ignore parsing errors
			}
		}

		return undefined;
	}
}

interface SummaryMessageProps extends BasePromptElementProps {
	readonly summaryText: string;
	readonly endpoint: IChatEndpoint;
}

class SummaryMessageElement extends PromptElement<SummaryMessageProps> {
	override async render(state: void, sizing: PromptSizing) {
		return <UserMessage>
			<Tag name='conversation-summary'>
				{this.props.summaryText}
			</Tag>
			{this.props.endpoint.family === 'gpt-4.1' && <Tag name='reminderInstructions'>
				<DefaultOpenAIKeepGoingReminder />
			</Tag>}
		</UserMessage>;
	}
}