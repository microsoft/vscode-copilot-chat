/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken, ChatRequest, ChatResponseProgressPart, ChatResponseReferencePart, ChatResponseStream, ChatResult, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { IChatHookService, StopHookInput, StopHookOutput, SubagentStartHookInput, SubagentStartHookOutput, SubagentStopHookInput, SubagentStopHookOutput } from '../../../platform/chat/common/chatHookService';
import { FetchStreamSource, IResponsePart } from '../../../platform/chat/common/chatMLFetcher';
import { CanceledResult, ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isAnthropicFamily } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { rawPartAsThinkingData } from '../../../platform/endpoint/common/thinkingDataContainer';
import { ILogService } from '../../../platform/log/common/logService';
import { OpenAiFunctionDef } from '../../../platform/networking/common/fetch';
import { IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { computePromptTokenDetails } from '../../../platform/tokenizer/node/promptTokenDetails';
import { tryFinalizeResponseStream } from '../../../util/common/chatResponseStreamImpl';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Mutable } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponsePullRequestPart, LanguageModelDataPart2, LanguageModelPartAudience, LanguageModelTextPart, LanguageModelToolResult2, MarkdownString } from '../../../vscodeTypes';
import { InteractionOutcomeComputer } from '../../inlineChat/node/promptCraftingTypes';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { AnthropicTokenUsageMetadata, Conversation, IResultMetadata, ResponseStreamParticipant, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext, InternalToolReference, IToolCall, IToolCallRound } from '../../prompt/common/intents';
import { cancelText, IToolCallIterationIncrease } from '../../prompt/common/specialRequestTypes';
import { ThinkingDataItem, ToolCallRound } from '../../prompt/common/toolCallRound';
import { IBuildPromptResult, IResponseProcessor } from '../../prompt/node/intents';
import { PseudoStopStartResponseProcessor } from '../../prompt/node/pseudoStartStopConversationCallback';
import { ResponseProcessorContext } from '../../prompt/node/responseProcessorContext';
import { SummarizedConversationHistoryMetadata } from '../../prompts/node/agent/summarizedConversationHistory';
import { ToolFailureEncountered, ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { ToolName } from '../../tools/common/toolNames';
import { ToolCallCancelledError } from '../../tools/common/toolsService';
import { ReadFileParams } from '../../tools/node/readFileTool';

export const enum ToolCallLimitBehavior {
	Confirm,
	Stop,
}

export interface IToolCallingLoopOptions {
	conversation: Conversation;
	toolCallLimit: number;
	/**
	 * What to do when the limit is hit. Defaults to {@link ToolCallLimitBehavior.Stop}.
	 * If set to confirm you can use {@link isToolCallLimitCancellation} and
	 * {@link isToolCallIterationIncrease} to get followup data.
	 */
	onHitToolCallLimit?: ToolCallLimitBehavior;
	/**
	 * "mixins" that can be used to wrap the response stream.
	 */
	streamParticipants?: ResponseStreamParticipant[];
	/**
	 * Optional custom response stream processor.
	 */
	responseProcessor?: IResponseProcessor;
	/** Context for the {@link InteractionOutcomeComputer} */
	interactionContext?: URI;
	/**
	 * The current chat request
	 */
	request: ChatRequest;
	/**
	 * A getter that returns true if VS Code has requested the extension to
	 * gracefully yield. When set, it's likely that the editor will immediately
	 * follow up with a new request in the same conversation.
	 */
	yieldRequested?: () => boolean;
}

export interface IToolCallingResponseEvent {
	response: ChatResponse;
	interactionOutcome: InteractionOutcomeComputer;
	toolCalls: IToolCall[];
}

export interface IToolCallingBuiltPromptEvent {
	result: IBuildPromptResult;
	tools: LanguageModelToolInformation[];
}

export type ToolCallingLoopFetchOptions = Required<Pick<IMakeChatRequestOptions, 'messages' | 'finishedCb' | 'requestOptions' | 'userInitiatedRequest'>> & Pick<IMakeChatRequestOptions, 'disableThinking'>;

interface StopHookResult {
	/**
	 * Whether the agent should continue (not stop).
	 */
	readonly shouldContinue: boolean;
	/**
	 * The reasons the agent should continue, if shouldContinue is true.
	 * Multiple hooks may block with different reasons.
	 */
	readonly reasons?: readonly string[];
}

interface SubagentStartHookResult {
	/**
	 * Additional context to add to the subagent's context, if any.
	 */
	readonly additionalContext?: string;
}

interface SubagentStopHookResult {
	/**
	 * Whether the subagent should continue (not stop).
	 */
	readonly shouldContinue: boolean;
	/**
	 * The reasons the subagent should continue, if shouldContinue is true.
	 * Multiple hooks may block with different reasons.
	 */
	readonly reasons?: readonly string[];
}

/**
 * Formats a hook context message from blocking reasons.
 * @param reasons The reasons hooks blocked the agent from stopping
 * @returns A formatted message for the model to address the requirements
 */
function formatHookContext(reasons: readonly string[]): string {
	if (reasons.length === 1) {
		return `You were about to complete but a hook blocked you with the following message: "${reasons[0]}". Please address this requirement before completing.`;
	}
	const formattedReasons = reasons.map((reason, i) => `${i + 1}. ${reason}`).join('\n');
	return `You were about to complete but multiple hooks blocked you with the following messages:\n${formattedReasons}\n\nPlease address all of these requirements before completing.`;
}

/**
 * This is a base class that can be used to implement a tool calling loop
 * against a model. It requires only that you build a prompt and is decoupled
 * from intents (i.e. the {@link DefaultIntentRequestHandler}), allowing easier
 * programmatic use.
 */
export abstract class ToolCallingLoop<TOptions extends IToolCallingLoopOptions = IToolCallingLoopOptions> extends Disposable {
	private static NextToolCallId = Date.now();

	private toolCallResults: Record<string, LanguageModelToolResult2> = Object.create(null);
	private toolCallRounds: IToolCallRound[] = [];
	private stopHookReason: string | undefined;
	private additionalHookContext: string | undefined;

	private readonly _onDidBuildPrompt = this._register(new Emitter<{ result: IBuildPromptResult; tools: LanguageModelToolInformation[]; promptTokenLength: number; toolTokenCount: number }>());
	public readonly onDidBuildPrompt = this._onDidBuildPrompt.event;

	private readonly _onDidReceiveResponse = this._register(new Emitter<IToolCallingResponseEvent>());
	public readonly onDidReceiveResponse = this._onDidReceiveResponse.event;

	private get turn() {
		return this.options.conversation.getLatestTurn();
	}

	constructor(
		protected readonly options: TOptions,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ILogService protected readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IAuthenticationChatUpgradeService private readonly _authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService protected readonly _telemetryService: ITelemetryService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExperimentationService protected readonly _experimentationService: IExperimentationService,
		@IChatHookService private readonly _chatHookService: IChatHookService,
	) {
		super();
	}

	/** Builds a prompt with the context. */
	protected abstract buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult>;

	/** Gets the tools that should be callable by the model. */
	protected abstract getAvailableTools(outputStream: ChatResponseStream | undefined, token: CancellationToken): Promise<LanguageModelToolInformation[]>;

	/** Creates the prompt context for the request. */
	protected createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): Mutable<IBuildPromptContext> {
		const { request } = this.options;
		const chatVariables = new ChatVariablesCollection(request.references);

		const isContinuation = this.turn.isContinuation || !!this.stopHookReason;
		let query: string;
		let hasStopHookQuery = false;
		if (this.stopHookReason) {
			// Include the stop hook reason as a user message so the model knows what to do.
			// Wrap with context so the model understands it needs to take action.
			query = formatHookContext([this.stopHookReason]);
			this._logService.info(`[ToolCallingLoop] Using stop hook reason as query: ${query}`);
			this.stopHookReason = undefined; // Clear after use
			hasStopHookQuery = true;
		} else if (isContinuation) {
			query = 'Please continue';
		} else {
			query = this.turn.request.message;
		}
		// exclude turns from the history that errored due to prompt filtration
		const history = this.options.conversation.turns.slice(0, -1).filter(turn => turn.responseStatus !== TurnStatus.PromptFiltered);

		return {
			requestId: this.turn.id,
			query,
			history,
			toolCallResults: this.toolCallResults,
			toolCallRounds: this.toolCallRounds,
			editedFileEvents: this.options.request.editedFileEvents,
			request: this.options.request,
			stream: outputStream,
			conversation: this.options.conversation,
			chatVariables,
			tools: {
				toolReferences: request.toolReferences.map(InternalToolReference.from),
				toolInvocationToken: request.toolInvocationToken,
				availableTools
			},
			isContinuation,
			hasStopHookQuery,
			modeInstructions: this.options.request.modeInstructions2,
			additionalHookContext: this.additionalHookContext,
		};
	}

	protected abstract fetch(
		options: ToolCallingLoopFetchOptions,
		token: CancellationToken
	): Promise<ChatResponse>;

	/**
	 * Called before the loop stops to give hooks a chance to block the stop.
	 * @param input The stop hook input containing stop_hook_active flag
	 * @param outputStream The output stream for displaying messages
	 * @param token Cancellation token
	 * @returns Result indicating whether to continue and the reasons
	 */
	protected async executeStopHook(input: StopHookInput, outputStream: ChatResponseStream | undefined, token: CancellationToken): Promise<StopHookResult> {
		try {
			const results = await this._chatHookService.executeHook('Stop', {
				toolInvocationToken: this.options.request.toolInvocationToken,
				input: input
			}, token);

			// Collect all blocking reasons (deduplicated)
			const blockingReasons = new Set<string>();
			for (const result of results) {
				if (result.success === true) {
					// Output may be a parsed object or a JSON string
					const output = result.output;
					if (typeof output === 'object' && output !== null) {
						const hookOutput = output as StopHookOutput;
						this._logService.trace(`[DefaultToolCallingLoop] Checking hook output: decision=${hookOutput.decision}, reason=${hookOutput.reason}`);
						if (hookOutput.decision === 'block' && hookOutput.reason) {
							this._logService.trace(`[DefaultToolCallingLoop] Stop hook blocked: ${hookOutput.reason}`);
							blockingReasons.add(hookOutput.reason);
						}
					}
				} else if (result.success === false) {
					const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
					this._logService.error(`[DefaultToolCallingLoop] Stop hook error: ${errorMessage}`);
				}
			}

			if (blockingReasons.size > 0) {
				return { shouldContinue: true, reasons: [...blockingReasons] };
			}
			return { shouldContinue: false };
		} catch (error) {
			this._logService.error('[DefaultToolCallingLoop] Error executing Stop hook', error);
			return { shouldContinue: false };
		}
	}

	/**
	 * Shows a message when the stop hook blocks the agent from stopping.
	 * Override in subclasses to customize the display.
	 * @param outputStream The output stream for displaying messages
	 * @param reasons The reasons the stop hook blocked stopping
	 */
	protected showStopHookBlockedMessage(outputStream: ChatResponseStream | undefined, reasons: readonly string[]): void {
		if (outputStream) {
			if (reasons.length === 1) {
				outputStream.warning(l10n.t('Stop hook: {0}', reasons[0]));
			} else {
				const formattedReasons = reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
				outputStream.warning(l10n.t('Stop hooks:\n{0}', formattedReasons));
			}
		}
		this._logService.trace(`[ToolCallingLoop] Stop hook blocked stopping: ${reasons.join('; ')}`);
	}

	/**
	 * Called when a subagent starts to allow hooks to provide additional context.
	 * @param input The subagent start hook input containing agent_id and agent_type
	 * @param token Cancellation token
	 * @returns Result containing additional context from hooks
	 */
	protected async executeSubagentStartHook(input: SubagentStartHookInput, token: CancellationToken): Promise<SubagentStartHookResult> {
		try {
			const results = await this._chatHookService.executeHook('SubagentStart', {
				toolInvocationToken: this.options.request.toolInvocationToken,
				input: input
			}, token);

			// Collect additionalContext from all successful hook results
			const additionalContexts: string[] = [];
			for (const result of results) {
				if (result.success === true) {
					const output = result.output;
					if (typeof output === 'object' && output !== null) {
						const hookOutput = output as SubagentStartHookOutput;
						if (hookOutput.additionalContext) {
							additionalContexts.push(hookOutput.additionalContext);
							this._logService.trace(`[ToolCallingLoop] SubagentStart hook provided context: ${hookOutput.additionalContext.substring(0, 100)}...`);
						}
					}
				} else if (result.success === false) {
					const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
					this._logService.error(`[ToolCallingLoop] SubagentStart hook error: ${errorMessage}`);
				}
			}

			return {
				additionalContext: additionalContexts.length > 0 ? additionalContexts.join('\n') : undefined
			};
		} catch (error) {
			this._logService.error('[ToolCallingLoop] Error executing SubagentStart hook', error);
			return {};
		}
	}

	/**
	 * Called before a subagent stops to give hooks a chance to block the stop.
	 * @param input The subagent stop hook input containing agent_id, agent_type, and stop_hook_active flag
	 * @param outputStream The output stream for displaying messages
	 * @param token Cancellation token
	 * @returns Result indicating whether to continue and the reasons
	 */
	protected async executeSubagentStopHook(input: SubagentStopHookInput, outputStream: ChatResponseStream | undefined, token: CancellationToken): Promise<SubagentStopHookResult> {
		try {
			const results = await this._chatHookService.executeHook('SubagentStop', {
				toolInvocationToken: this.options.request.toolInvocationToken,
				input: input
			}, token);

			// Collect all blocking reasons (deduplicated)
			const blockingReasons = new Set<string>();
			for (const result of results) {
				if (result.success === true) {
					const output = result.output;
					if (typeof output === 'object' && output !== null) {
						const hookOutput = output as SubagentStopHookOutput;
						this._logService.trace(`[ToolCallingLoop] Checking SubagentStop hook output: decision=${hookOutput.decision}, reason=${hookOutput.reason}`);
						if (hookOutput.decision === 'block' && hookOutput.reason) {
							this._logService.trace(`[ToolCallingLoop] SubagentStop hook blocked: ${hookOutput.reason}`);
							blockingReasons.add(hookOutput.reason);
						}
					}
				} else if (result.success === false) {
					const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
					this._logService.error(`[ToolCallingLoop] SubagentStop hook error: ${errorMessage}`);
				}
			}

			if (blockingReasons.size > 0) {
				return { shouldContinue: true, reasons: [...blockingReasons] };
			}
			return { shouldContinue: false };
		} catch (error) {
			this._logService.error('[ToolCallingLoop] Error executing SubagentStop hook', error);
			return { shouldContinue: false };
		}
	}

	/**
	 * Shows a message when the subagent stop hook blocks the subagent from stopping.
	 * Override in subclasses to customize the display.
	 * @param outputStream The output stream for displaying messages
	 * @param reasons The reasons the subagent stop hook blocked stopping
	 */
	protected showSubagentStopHookBlockedMessage(outputStream: ChatResponseStream | undefined, reasons: readonly string[]): void {
		if (outputStream) {
			if (reasons.length === 1) {
				outputStream.markdown('\n\n' + l10n.t('**Subagent stop hook:** {0}', reasons[0]) + '\n\n');
			} else {
				const formattedReasons = reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
				outputStream.markdown('\n\n' + l10n.t('**Subagent stop hooks:**\n{0}', formattedReasons) + '\n\n');
			}
		}
		this._logService.trace(`[ToolCallingLoop] SubagentStop hook blocked stopping: ${reasons.join('; ')}`);
	}

	private throwIfCancelled(token: CancellationToken) {
		if (token.isCancellationRequested) {
			this.turn.setResponse(TurnStatus.Cancelled, undefined, undefined, CanceledResult);
			throw new CancellationError();
		}
	}

	public async run(outputStream: ChatResponseStream | undefined, token: CancellationToken): Promise<IToolCallLoopResult> {
		let i = 0;
		let lastResult: IToolCallSingleResult | undefined;
		let lastRequestMessagesStartingIndexForRun: number | undefined;
		let stopHookActive = false;

		// Execute SubagentStart hook for subagent requests to get additional context
		if (this.options.request.subAgentInvocationId) {
			const startHookResult = await this.executeSubagentStartHook({
				agent_id: this.options.request.subAgentInvocationId,
				agent_type: this.options.request.subAgentName ?? 'default'
			}, token);
			if (startHookResult.additionalContext) {
				this.additionalHookContext = startHookResult.additionalContext;
				this._logService.info(`[ToolCallingLoop] SubagentStart hook provided context for subagent ${this.options.request.subAgentInvocationId}`);
			}
		}

		while (true) {
			if (lastResult && i++ >= this.options.toolCallLimit) {
				lastResult = this.hitToolCallLimit(outputStream, lastResult);
				break;
			}

			// Check if VS Code has requested we gracefully yield before starting the next iteration
			if (lastResult && this.options.yieldRequested?.()) {
				break;
			}

			try {
				const result = await this.runOne(outputStream, i, token);
				if (lastRequestMessagesStartingIndexForRun === undefined) {
					lastRequestMessagesStartingIndexForRun = result.lastRequestMessages.length - 1;
				}
				lastResult = {
					...result,
					hadIgnoredFiles: lastResult?.hadIgnoredFiles || result.hadIgnoredFiles
				};

				this.toolCallRounds.push(result.round);
				if (!result.round.toolCalls.length || result.response.type !== ChatFetchResponseType.Success) {
					// Before stopping, execute the stop hook
					if (this.options.request.subAgentInvocationId) {
						const stopHookResult = await this.executeSubagentStopHook({
							agent_id: this.options.request.subAgentInvocationId,
							agent_type: this.options.request.subAgentName ?? 'default',
							stop_hook_active: stopHookActive
						}, outputStream, token);
						const joinedReasons = stopHookResult.reasons?.join('; ');
						this._logService.info(`[ToolCallingLoop] Subagent stop hook result: shouldContinue=${stopHookResult.shouldContinue}, reasons=${joinedReasons}`);
						if (stopHookResult.shouldContinue && stopHookResult.reasons?.length) {
							// The stop hook blocked stopping - show reasons and continue
							this.showSubagentStopHookBlockedMessage(outputStream, stopHookResult.reasons);
							// Store the joined reasons so it can be passed to the model in the next prompt
							this.stopHookReason = joinedReasons;
							// Also persist on the round so it survives across turns
							result.round.hookContext = formatHookContext(stopHookResult.reasons);
							this._logService.info(`[ToolCallingLoop] Subagent stop hook blocked, continuing with reasons: ${joinedReasons}`);
							stopHookActive = true;
							continue;
						}
					} else {
						const stopHookResult = await this.executeStopHook({ stop_hook_active: stopHookActive }, outputStream, token);
						const joinedReasons = stopHookResult.reasons?.join('; ');
						this._logService.info(`[ToolCallingLoop] Stop hook result: shouldContinue=${stopHookResult.shouldContinue}, reasons=${joinedReasons}`);
						if (stopHookResult.shouldContinue && stopHookResult.reasons?.length) {
							// The stop hook blocked stopping - show reasons and continue
							this.showStopHookBlockedMessage(outputStream, stopHookResult.reasons);
							// Store the joined reasons so it can be passed to the model in the next prompt
							this.stopHookReason = joinedReasons;
							// Also persist on the round so it survives across turns
							result.round.hookContext = formatHookContext(stopHookResult.reasons);
							this._logService.info(`[ToolCallingLoop] Stop hook blocked, continuing with reasons: ${joinedReasons}`);
							stopHookActive = true;
							continue;
						}
					}
					lastResult = lastResult;
					break;
				}
			} catch (e) {
				if (isCancellationError(e) && lastResult) {
					lastResult = lastResult;
					break;
				}

				throw e;
			}
		}

		this.emitReadFileTrajectories().catch(err => {
			this._logService.error('Error emitting read file trajectories', err);
		});

		const toolCallRoundsToDisplay = lastResult.lastRequestMessages.slice(lastRequestMessagesStartingIndexForRun ?? 0).filter((m): m is Raw.ToolChatMessage => m.role === Raw.ChatRole.Tool);
		for (const toolRound of toolCallRoundsToDisplay) {
			const result = this.toolCallResults[toolRound.toolCallId];
			if (result instanceof LanguageModelToolResult2) {
				for (const part of result.content) {
					if (part instanceof LanguageModelDataPart2 && part.mimeType === 'application/pull-request+json' && part.audience?.includes(LanguageModelPartAudience.User)) {
						const data: { uri: string; title: string; description: string; author: string; linkTag: string } = JSON.parse(part.data.toString());
						outputStream?.push(new ChatResponsePullRequestPart(URI.parse(data.uri), data.title, data.description, data.author, data.linkTag));
					}
				}
			}
		}
		return { ...lastResult, toolCallRounds: this.toolCallRounds, toolCallResults: this.toolCallResults };
	}

	private async emitReadFileTrajectories() {
		// We are tuning our `read_file` tool to read files more effectively and efficiently.
		// This is a likely-temporary function that emits trajectory telemetry read_files
		// at the end of each agentic loop so that we can do so, in addition to the
		// per-call telemetry in ReadFileTool

		function tryGetRFArgs(call: IToolCall): ReadFileParams | undefined {
			if (call.name !== ToolName.ReadFile) {
				return undefined;
			}
			try {
				return JSON.parse(call.arguments);
			} catch {
				return undefined;
			}
		}

		const consumed = new Set<string>();
		const tcrs = this.toolCallRounds;
		for (let i = 0; i < tcrs.length; i++) {
			const { toolCalls } = tcrs[i];
			for (const call of toolCalls) {
				if (consumed.has(call.id)) {
					continue;
				}
				const args = tryGetRFArgs(call);
				if (!args) {
					continue;
				}

				const seqArgs = [args];
				consumed.add(call.id);

				for (let k = i + 1; k < tcrs.length; k++) {
					for (const call2 of tcrs[k].toolCalls) {
						if (consumed.has(call2.id)) {
							continue;
						}

						const args2 = tryGetRFArgs(call2);
						if (!args2 || args2.filePath !== args.filePath) {
							continue;
						}

						consumed.add(call2.id);
						seqArgs.push(args2);
					}
				}

				let chunkSizeTotal = 0;
				let chunkSizeNo = 0;
				for (const arg of seqArgs) {
					if ('startLine' in arg) {
						chunkSizeNo++;
						chunkSizeTotal += arg.endLine - arg.startLine + 1;
					} else if (arg.limit) {
						chunkSizeNo++;
						chunkSizeTotal += arg.limit;
					}
				}

				/* __GDPR__
					"readFileTrajectory" : {
						"owner": "connor4312",
						"comment": "read_file tool invokation trajectory",
						"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that invoked the tool" },
						"rounds": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of times the file was read sequentially" },
						"avgChunkSize": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of lines read at a time" }
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('readFileTrajectory',
					{
						// model will be undefined in the simulator
						model: this.options.request.model?.id,
					},
					{
						rounds: seqArgs.length,
						avgChunkSize: chunkSizeNo > 0 ? Math.round(chunkSizeTotal / chunkSizeNo) : -1,
					}
				);
			}
		}
	}

	private hitToolCallLimit(stream: ChatResponseStream | undefined, lastResult: IToolCallSingleResult) {
		if (stream && this.options.onHitToolCallLimit === ToolCallLimitBehavior.Confirm) {
			const messageString = new MarkdownString(l10n.t({
				message: 'Copilot has been working on this problem for a while. It can continue to iterate, or you can send a new message to refine your prompt. [Configure max requests]({0}).',
				args: [`command:workbench.action.openSettings?${encodeURIComponent('["chat.agent.maxRequests"]')}`],
				comment: 'Link to workbench settings for chat.maxRequests, which controls the maximum number of requests Copilot will make before stopping. This is used in the tool calling loop to determine when to stop iterating on a problem.'
			}));
			messageString.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };

			stream.confirmation(
				l10n.t('Continue to iterate?'),
				messageString,
				{ copilotRequestedRoundLimit: Math.round(this.options.toolCallLimit * 3 / 2) } satisfies IToolCallIterationIncrease,
				[
					l10n.t('Continue'),
					cancelText(),
				]
			);
		}

		lastResult.chatResult = {
			...lastResult.chatResult,
			metadata: {
				...lastResult.chatResult?.metadata,
				maxToolCallsExceeded: true
			} satisfies Partial<IResultMetadata>,
		};

		return lastResult;
	}

	/** Runs a single iteration of the tool calling loop. */
	public async runOne(outputStream: ChatResponseStream | undefined, iterationNumber: number, token: CancellationToken): Promise<IToolCallSingleResult> {
		let availableTools = await this.getAvailableTools(outputStream, token);
		const context = this.createPromptContext(availableTools, outputStream);
		const isContinuation = context.isContinuation || false;
		const buildPromptResult: IBuildPromptResult = await this.buildPrompt2(context, outputStream, token);
		this.throwIfCancelled(token);
		this.turn.addReferences(buildPromptResult.references);
		// Possible the tool call resulted in new tools getting added.
		availableTools = await this.getAvailableTools(outputStream, token);

		const isToolInputFailure = buildPromptResult.metadata.get(ToolFailureEncountered);
		const conversationSummary = buildPromptResult.metadata.get(SummarizedConversationHistoryMetadata);
		if (conversationSummary) {
			this.turn.setMetadata(conversationSummary);
		}
		const endpoint = await this._endpointProvider.getChatEndpoint(this.options.request);
		const tokenizer = endpoint.acquireTokenizer();
		const promptTokenLength = await tokenizer.countMessagesTokens(buildPromptResult.messages);
		const toolTokenCount = availableTools.length > 0 ? await tokenizer.countToolTokens(availableTools) : 0;
		this.throwIfCancelled(token);
		this._onDidBuildPrompt.fire({ result: buildPromptResult, tools: availableTools, promptTokenLength, toolTokenCount });
		this._logService.trace('Built prompt');

		// Tool calls happen during prompt building. Check yield again here to see if we should abort prior to sending off the next request.
		if (iterationNumber > 0 && this.options.yieldRequested?.()) {
			throw new CancellationError();
		}

		// todo@connor4312: can interaction outcome logic be implemented in a more generic way?
		const interactionOutcomeComputer = new InteractionOutcomeComputer(this.options.interactionContext);

		const that = this;
		const responseProcessor = new class implements IResponseProcessor {

			private readonly context = new ResponseProcessorContext(that.options.conversation.sessionId, that.turn, buildPromptResult.messages, interactionOutcomeComputer);

			async processResponse(_context: unknown, inputStream: AsyncIterable<IResponsePart>, responseStream: ChatResponseStream, token: CancellationToken): Promise<ChatResult | void> {
				let chatResult: ChatResult | void = undefined;
				if (that.options.responseProcessor) {
					chatResult = await that.options.responseProcessor.processResponse(this.context, inputStream, responseStream, token);
				} else {
					const responseProcessor = that._instantiationService.createInstance(PseudoStopStartResponseProcessor, [], undefined, { subagentInvocationId: that.options.request.subAgentInvocationId });
					await responseProcessor.processResponse(this.context, inputStream, responseStream, token);
				}
				return chatResult;
			}
		}();

		this._logService.trace('Sending prompt to model');

		const streamParticipants = outputStream ? [outputStream] : [];
		let fetchStreamSource: FetchStreamSource | undefined;
		let processResponsePromise: Promise<ChatResult | void> | undefined;
		let stopEarly = false;
		if (outputStream) {
			this.options.streamParticipants?.forEach(fn => {
				streamParticipants.push(fn(streamParticipants[streamParticipants.length - 1]));
			});
			const stream = streamParticipants[streamParticipants.length - 1];

			fetchStreamSource = new FetchStreamSource();
			processResponsePromise = responseProcessor.processResponse(undefined, fetchStreamSource.stream, stream, token);

			// Allows the response processor to do an early stop of the LLM request.
			processResponsePromise.finally(() => {
				// The response processor indicates that it has finished processing the response,
				// so let's stop the request if it's still in flight.
				stopEarly = true;
			});
		}

		if (buildPromptResult.messages.length === 0) {
			// /fixTestFailure relies on this check running after processResponse
			fetchStreamSource?.resolve();
			await processResponsePromise;
			await finalizeStreams(streamParticipants);
			throw new EmptyPromptError();
		}

		const promptContextTools = availableTools.length ? availableTools.map(toolInfo => {
			return {
				name: toolInfo.name,
				description: toolInfo.description,
				parameters: toolInfo.inputSchema,
			} satisfies OpenAiFunctionDef;
		}) : undefined;
		let statefulMarker: string | undefined;
		const toolCalls: IToolCall[] = [];
		let thinkingItem: ThinkingDataItem | undefined;
		const disableThinking = isContinuation && isAnthropicFamily(endpoint) && !ToolCallingLoop.messagesContainThinking(buildPromptResult.messages);
		const fetchResult = await this.fetch({
			messages: this.applyMessagePostProcessing(buildPromptResult.messages),
			finishedCb: async (text, index, delta) => {
				fetchStreamSource?.update(text, delta);
				if (delta.copilotToolCalls) {
					toolCalls.push(...delta.copilotToolCalls.map((call): IToolCall => ({
						...call,
						id: this.createInternalToolCallId(call.id),
						arguments: call.arguments === '' ? '{}' : call.arguments
					})));
				}
				if (delta.serverToolCalls) {
					for (const serverCall of delta.serverToolCalls) {
						const result: LanguageModelToolResult2 = {
							content: [new LanguageModelTextPart(JSON.stringify(serverCall.result, undefined, 2))]
						};
						this._requestLogger.logServerToolCall(serverCall.id, serverCall.name, serverCall.args, result);
					}
				}
				if (delta.statefulMarker) {
					statefulMarker = delta.statefulMarker;
				}
				if (delta.thinking) {
					thinkingItem = ThinkingDataItem.createOrUpdate(thinkingItem, delta.thinking);
				}
				return stopEarly ? text.length : undefined;
			},
			requestOptions: {
				tools: promptContextTools?.map(tool => ({
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters && Object.keys(tool.parameters).length ? tool.parameters : undefined
					},
					type: 'function',
				})),
			},
			userInitiatedRequest: iterationNumber === 0 && !isContinuation && !this.options.request.subAgentInvocationId,
			disableThinking,
		}, token);

		const promptTokenDetails = await computePromptTokenDetails({
			messages: buildPromptResult.messages,
			tokenizer,
			tools: availableTools,
		});
		fetchStreamSource?.resolve();
		const chatResult = await processResponsePromise ?? undefined;

		// Report token usage to the stream for rendering the context window widget
		const stream = streamParticipants[streamParticipants.length - 1];
		if (fetchResult.type === ChatFetchResponseType.Success && fetchResult.usage && stream) {
			stream.usage({
				completionTokens: fetchResult.usage.completion_tokens,
				promptTokens: fetchResult.usage.prompt_tokens,
				promptTokenDetails,
			});
		}

		// Validate authentication session upgrade and handle accordingly
		if (
			outputStream &&
			toolCalls.some(tc => tc.name === ToolName.Codebase) &&
			await this._authenticationChatUpgradeService.shouldRequestPermissiveSessionUpgrade()
		) {
			this._authenticationChatUpgradeService.showPermissiveSessionUpgradeInChat(outputStream, this.options.request);
			throw new ToolCallCancelledError(new CancellationError());
		}

		await finalizeStreams(streamParticipants);
		this._onDidReceiveResponse.fire({ interactionOutcome: interactionOutcomeComputer, response: fetchResult, toolCalls });

		this.turn.setMetadata(interactionOutcomeComputer.interactionOutcome);

		const toolInputRetry = isToolInputFailure ? (this.toolCallRounds.at(-1)?.toolInputRetry || 0) + 1 : 0;
		if (fetchResult.type === ChatFetchResponseType.Success) {
			// Store token usage metadata for Anthropic models using Messages API
			if (fetchResult.usage && isAnthropicFamily(endpoint)) {
				this.turn.setMetadata(new AnthropicTokenUsageMetadata(
					fetchResult.usage.prompt_tokens,
					fetchResult.usage.completion_tokens
				));
			}

			thinkingItem?.updateWithFetchResult(fetchResult);
			return {
				response: fetchResult,
				round: ToolCallRound.create({
					response: fetchResult.value,
					toolCalls,
					toolInputRetry,
					statefulMarker,
					thinking: thinkingItem
				}),
				chatResult,
				hadIgnoredFiles: buildPromptResult.hasIgnoredFiles,
				lastRequestMessages: buildPromptResult.messages,
				availableTools,
			};
		}

		return {
			response: fetchResult,
			hadIgnoredFiles: buildPromptResult.hasIgnoredFiles,
			lastRequestMessages: buildPromptResult.messages,
			availableTools,
			round: new ToolCallRound('', toolCalls, toolInputRetry)
		};
	}

	/**
	 * Sometimes 4o reuses tool call IDs, so make sure they are unique. Really we should restructure how tool calls and results are represented
	 * to not expect them to be globally unique.
	 */
	private createInternalToolCallId(toolCallId: string): string {
		// Note- if this code is ever removed, these IDs will still exist in persisted session metadata!
		return toolCallId + `__vscode-${ToolCallingLoop.NextToolCallId++}`;
	}

	private applyMessagePostProcessing(messages: Raw.ChatMessage[]): Raw.ChatMessage[] {
		return this.validateToolMessages(
			ToolCallingLoop.stripInternalToolCallIds(messages));
	}

	public static stripInternalToolCallIds(messages: Raw.ChatMessage[]): Raw.ChatMessage[] {
		return messages.map(m => {
			if (m.role === Raw.ChatRole.Assistant) {
				return {
					...m,
					toolCalls: m.toolCalls?.map(tc => ({
						...tc,
						id: tc.id.split('__vscode-')[0]
					}))
				};
			} else if (m.role === Raw.ChatRole.Tool) {
				return {
					...m,
					toolCallId: m.toolCallId?.split('__vscode-')[0]
				};
			}

			return m;
		});
	}

	public static messagesContainThinking(messages: Raw.ChatMessage[]): boolean {
		let lastUserMessageIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === Raw.ChatRole.User) {
				lastUserMessageIndex = i;
				break;
			}
		}

		// If no user message found, return false to disable thinking
		if (lastUserMessageIndex === -1) {
			return false;
		}

		for (let i = lastUserMessageIndex + 1; i < messages.length; i++) {
			const m = messages[i];
			if (m.role !== Raw.ChatRole.Assistant) {
				continue;
			}
			return Array.isArray(m.content) && m.content.some(part =>
				part.type === Raw.ChatCompletionContentPartKind.Opaque && rawPartAsThinkingData(part) !== undefined
			);
		}
		return false;
	}

	/**
	 * Apparently we can render prompts which have a tool message which is out of place. Don't know why this is happening, but try to detect this and fix it up.
	 */
	private validateToolMessages(messages: Raw.ChatMessage[]): Raw.ChatMessage[] {
		const filterReasons: string[] = [];
		let previousAssistantMessage: Raw.AssistantChatMessage | undefined;
		const filtered = messages.filter((m, i) => {
			if (m.role === Raw.ChatRole.Assistant) {
				previousAssistantMessage = m;
			} else if (m.role === Raw.ChatRole.Tool) {
				if (!previousAssistantMessage) {
					// No previous assistant message
					filterReasons.push('noPreviousAssistantMessage');
					return false;
				}

				if (!previousAssistantMessage.toolCalls?.length) {
					// The assistant did not call any tools
					filterReasons.push('noToolCalls');
					return false;
				}

				const toolCall = previousAssistantMessage.toolCalls.find(tc => tc.id === m.toolCallId);
				if (!toolCall) {
					// This tool call is excluded
					return false;
				}
			}

			return true;
		});

		if (filterReasons.length) {
			const filterReasonsStr = filterReasons.join(', ');
			this._logService.warn('Filtered invalid tool messages: ' + filterReasonsStr);
			/* __GDPR__
					"toolCalling.invalidToolMessages" : {
						"owner": "roblourens",
						"comment": "Provides info about invalid tool messages that were rendered in a prompt",
						"filterReasons": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reasons for filtering the messages." },
						"filterCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Count of filtered messages." }
					}
				*/
			this._telemetryService.sendMSFTTelemetryEvent('toolCalling.invalidToolMessages', {
				filterReasons: filterReasonsStr,
			}, {
				filterCount: filterReasons.length
			});
		}

		return filtered;
	}

	private async buildPrompt2(buildPromptContext: IBuildPromptContext, stream: ChatResponseStream | undefined, token: CancellationToken): Promise<IBuildPromptResult> {
		const progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart> = {
			report(obj) {
				stream?.push(obj);
			}
		};

		const buildPromptResult = await this.buildPrompt(buildPromptContext, progress, token);
		for (const metadata of buildPromptResult.metadata.getAll(ToolResultMetadata)) {
			this.logToolResult(buildPromptContext, metadata);
			this.toolCallResults[metadata.toolCallId] = metadata.result;
		}

		if (buildPromptResult.metadata.getAll(ToolResultMetadata).some(r => r.isCancelled)) {
			throw new CancellationError();
		}

		return buildPromptResult;
	}


	private logToolResult(buildPromptContext: IBuildPromptContext, metadata: ToolResultMetadata) {
		if (this.toolCallResults[metadata.toolCallId]) {
			return; // already logged this on a previous turn
		}

		const lastTurn = this.toolCallRounds.at(-1);
		let originalCall = lastTurn?.toolCalls.find(tc => tc.id === metadata.toolCallId);
		if (!originalCall) {
			const byRef = buildPromptContext.tools?.toolReferences.find(r => r.id === metadata.toolCallId);
			if (byRef) {
				originalCall = { id: byRef.id, arguments: JSON.stringify(byRef.input), name: byRef.name };
			}
		}

		if (originalCall) {
			this._requestLogger.logToolCall(originalCall.id || generateUuid(), originalCall.name, originalCall.arguments, metadata.result, lastTurn?.thinking);
		}
	}
}

async function finalizeStreams(streams: readonly ChatResponseStream[]) {
	for (const stream of streams) {
		await tryFinalizeResponseStream(stream);
	}
}

export class EmptyPromptError extends Error {
	constructor() {
		super('Empty prompt');
	}
}

export interface IToolCallSingleResult {
	response: ChatResponse;
	round: IToolCallRound;
	chatResult?: ChatResult; // TODO should just be metadata
	hadIgnoredFiles: boolean;
	lastRequestMessages: Raw.ChatMessage[];
	availableTools: readonly LanguageModelToolInformation[];
}

export interface IToolCallLoopResult extends IToolCallSingleResult {
	toolCallRounds: IToolCallRound[];
	toolCallResults: Record<string, LanguageModelToolResult2>;
}
