/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken, ChatRequest, ChatResponseProgressPart, ChatResponseReferencePart, ChatResponseStream, ChatResult, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { FetchStreamSource, IResponsePart } from '../../../platform/chat/common/chatMLFetcher';
import { CanceledResult, ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OpenAiFunctionDef, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { tryFinalizeResponseStream } from '../../../util/common/chatResponseStreamImpl';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { Mutable } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponsePullRequestPart, LanguageModelDataPart2, LanguageModelToolResult2, MarkdownString, ToolResultAudience } from '../../../vscodeTypes';
import { InteractionOutcomeComputer } from '../../inlineChat/node/promptCraftingTypes';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, IResultMetadata, ResponseStreamParticipant, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext, InternalToolReference, IToolCall, IToolCallRound } from '../../prompt/common/intents';
import { ToolCallRound } from '../../prompt/common/toolCallRound';
import { IBuildPromptResult, IResponseProcessor } from '../../prompt/node/intents';
import { PseudoStopStartResponseProcessor } from '../../prompt/node/pseudoStartStopConversationCallback';
import { ResponseProcessorContext } from '../../prompt/node/responseProcessorContext';
import { SummarizedConversationHistoryMetadata } from '../../prompts/node/agent/summarizedConversationHistory';
import { ToolFailureEncountered, ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { ToolName } from '../../tools/common/toolNames';
import { ToolCallCancelledError } from '../../tools/common/toolsService';
import { ReadFileParams } from '../../tools/node/readFileTool';
import { PauseController } from './pauseController';


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

	private readonly _onDidBuildPrompt = this._register(new Emitter<{ result: IBuildPromptResult; tools: LanguageModelToolInformation[]; promptTokenLength: number }>());
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
		@IThinkingDataService private readonly _thinkingDataService: IThinkingDataService,
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

		const isContinuation = isToolCallLimitAcceptance(this.options.request) || isContinueOnError(this.options.request);
		const query = isContinuation ?
			'Please continue' :
			this.turn.request.message;
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
			modeInstructions: this.options.request.modeInstructions,
		};
	}

	protected abstract fetch(
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback,
		requestOptions: OptionalChatRequestParams,
		firstFetchCall: boolean,
		token: CancellationToken
	): Promise<ChatResponse>;

	private async throwIfCancelled(token: CancellationToken | PauseController) {
		if (await this.checkAsync(token)) {
			throw new CancellationError();
		}
	}

	public async run(outputStream: ChatResponseStream | undefined, token: CancellationToken | PauseController): Promise<IToolCallLoopResult> {
		let i = 0;
		let lastResult: IToolCallSingleResult | undefined;
		let lastRequestMessagesStartingIndexForRun: number | undefined;

		while (true) {
			if (lastResult && i++ >= this.options.toolCallLimit) {
				lastResult = this.hitToolCallLimit(outputStream, lastResult);
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
					if (part instanceof LanguageModelDataPart2 && part.mimeType === 'application/pull-request+json' && part.audience?.includes(ToolResultAudience.User)) {
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
						model: this.options.request.model.id,
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
	public async runOne(outputStream: ChatResponseStream | undefined, iterationNumber: number, token: CancellationToken | PauseController): Promise<IToolCallSingleResult> {
		let availableTools = await this.getAvailableTools(outputStream, token);
		const context = this.createPromptContext(availableTools, outputStream);
		const isContinuation = context.isContinuation || false;
		const buildPromptResult: IBuildPromptResult = await this.buildPrompt2(context, outputStream, token);
		await this.throwIfCancelled(token);
		this.turn.addReferences(buildPromptResult.references);
		// Possible the tool call resulted in new tools getting added.
		availableTools = await this.getAvailableTools(outputStream, token);

		const isToolInputFailure = buildPromptResult.metadata.get(ToolFailureEncountered);
		const conversationSummary = buildPromptResult.metadata.get(SummarizedConversationHistoryMetadata);
		if (conversationSummary) {
			this.turn.setMetadata(conversationSummary);
		}
		const promptTokenLength = await (await this._endpointProvider.getChatEndpoint(this.options.request)).acquireTokenizer().countMessagesTokens(buildPromptResult.messages);
		await this.throwIfCancelled(token);
		this._onDidBuildPrompt.fire({ result: buildPromptResult, tools: availableTools, promptTokenLength });
		this._logService.trace('Built prompt');

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
					const responseProcessor = that._instantiationService.createInstance(PseudoStopStartResponseProcessor, [], undefined);
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

			const disposables = new DisposableStore();
			if (token instanceof PauseController) {
				disposables.add(token.onDidChangePause(isPaused => {
					if (isPaused) {
						fetchStreamSource?.pause();
					} else {
						fetchStreamSource?.unpause();
					}
				}));
			}

			// Allows the response processor to do an early stop of the LLM request.
			processResponsePromise.finally(() => {
				// The response processor indicates that it has finished processing the response,
				// so let's stop the request if it's still in flight.
				stopEarly = true;

				disposables.dispose();
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
		const toolCalls: IToolCall[] = [];
		const fixedMessages = this.applyMessagePostProcessing(buildPromptResult.messages);
		const fetchResult = await this.fetch(
			fixedMessages,
			async (text, _, delta) => {
				fetchStreamSource?.update(text, delta);
				if (delta.copilotToolCalls) {
					toolCalls.push(...delta.copilotToolCalls.map((call): IToolCall => ({
						...call,
						id: this.createInternalToolCallId(call.id),
						arguments: call.arguments === '' ? '{}' : call.arguments
					})));
				}

				return stopEarly ? text.length : undefined;
			},
			{
				tools: promptContextTools?.map(tool => ({
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters && Object.keys(tool.parameters).length ? tool.parameters : undefined
					},
					type: 'function',
				})),
			},
			iterationNumber === 0 && !isContinuation,
			token,
		);

		fetchStreamSource?.resolve();
		const chatResult = await processResponsePromise ?? undefined;

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
			return {
				response: fetchResult,
				round: new ToolCallRound(
					fetchResult.value,
					toolCalls,
					toolInputRetry,
					undefined,
				),
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
			round: new ToolCallRound('', toolCalls, toolInputRetry, undefined)
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

	/**
	 * Should be called between async operations. It cancels the operations and
	 * returns true if the operation should be aborted, and waits for pausing otherwise.
	 */
	private async checkAsync(token: CancellationToken | PauseController): Promise<boolean> {
		if (token instanceof PauseController && token.isPaused) {
			await token.waitForUnpause();
		}

		if (token.isCancellationRequested) {
			this.turn.setResponse(TurnStatus.Cancelled, undefined, undefined, CanceledResult);
			return true;
		}

		return false;
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
			const thinking = this._thinkingDataService.get(originalCall.id);
			this._requestLogger.logToolCall(originalCall.id || generateUuid(), originalCall.name, originalCall.arguments, metadata.result, thinking);
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

interface IToolCallIterationIncrease {
	copilotRequestedRoundLimit: number;
}

const isToolCallIterationIncrease = (c: any): c is IToolCallIterationIncrease => c && typeof c.copilotRequestedRoundLimit === 'number';

export const getRequestedToolCallIterationLimit = (request: ChatRequest) => request.acceptedConfirmationData?.find(isToolCallIterationIncrease)?.copilotRequestedRoundLimit;
// todo@connor4312 improve with the choices API
export const isToolCallLimitCancellation = (request: ChatRequest) => !!getRequestedToolCallIterationLimit(request) && request.prompt.includes(cancelText());
export const isToolCallLimitAcceptance = (request: ChatRequest) => !!getRequestedToolCallIterationLimit(request) && !isToolCallLimitCancellation(request);
export interface IContinueOnErrorConfirmation {
	copilotContinueOnError: true;
}
function isContinueOnErrorConfirmation(c: unknown): c is IContinueOnErrorConfirmation {
	return !!(c && (c as IContinueOnErrorConfirmation).copilotContinueOnError === true);
}
export const isContinueOnError = (request: ChatRequest) => !!(request.acceptedConfirmationData?.some(isContinueOnErrorConfirmation));
const cancelText = () => l10n.t('Pause');
