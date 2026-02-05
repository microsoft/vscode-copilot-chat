/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw } from '@vscode/prompt-tsx';
import type { ChatRequest, ChatResponseReferencePart, ChatResponseStream, ChatResult, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ICopilotTokenStore } from '../../../platform/authentication/common/copilotTokenStore';
import { IChatHookService, SubagentStartHookInput, SubagentStartHookOutput, SubagentStopHookInput, SubagentStopHookOutput, UserPromptSubmitHookInput } from '../../../platform/chat/common/chatHookService';
import { CanceledResult, ChatFetchResponseType, ChatLocation, ChatResponse, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { IConversationOptions } from '../../../platform/chat/common/conversationOptions';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEditSurvivalTrackerService, IEditSurvivalTrackingSession, NullEditSurvivalTrackingSession } from '../../../platform/editSurvivalTracking/common/editSurvivalTrackerService';
import { isAnthropicFamily } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { HAS_IGNORED_FILES_MESSAGE } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { isAnthropicToolSearchEnabled } from '../../../platform/networking/common/anthropic';
import { IResponseDelta, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { FilterReason } from '../../../platform/networking/common/openai';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ISurveyService } from '../../../platform/survey/common/surveyService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Event } from '../../../util/vs/base/common/event';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { mixin } from '../../../util/vs/base/common/objects';
import { assertType, Mutable } from '../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart, ChatResponseProgressPart, ChatResponseTextEditPart, LanguageModelToolResult2 } from '../../../vscodeTypes';
import { CodeBlocksMetadata, CodeBlockTrackingChatResponseStream } from '../../codeBlocks/node/codeBlockProcessor';
import { CopilotInteractiveEditorResponse, InteractionOutcomeComputer } from '../../inlineChat/node/promptCraftingTypes';
import { PauseController } from '../../intents/node/pauseController';
import { EmptyPromptError, IToolCallingBuiltPromptEvent, IToolCallingLoopOptions, IToolCallingResponseEvent, IToolCallLoopResult, ToolCallingLoop, ToolCallingLoopFetchOptions, ToolCallLimitBehavior } from '../../intents/node/toolCallingLoop';
import { UnknownIntent } from '../../intents/node/unknownIntent';
import { ResponseStreamWithLinkification } from '../../linkify/common/responseStreamWithLinkification';
import { SummarizedConversationHistoryMetadata } from '../../prompts/node/agent/summarizedConversationHistory';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { ToolCallCancelledError } from '../../tools/common/toolsService';
import { IToolGrouping, IToolGroupingService } from '../../tools/common/virtualTools/virtualToolTypes';
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { AnthropicTokenUsageMetadata, Conversation, getUniqueReferences, GlobalContextMessageMetadata, IResultMetadata, RenderedUserMessageMetadata, RequestDebugInformation, ResponseStreamParticipant, Turn, TurnStatus } from '../common/conversation';
import { IBuildPromptContext, IToolCallRound } from '../common/intents';
import { isToolCallLimitCancellation } from '../common/specialRequestTypes';
import { ChatTelemetry, ChatTelemetryBuilder } from './chatParticipantTelemetry';
import { IntentInvocationMetadata } from './conversation';
import { IDocumentContext } from './documentContext';
import { IBuildPromptResult, IIntent, IIntentInvocation, IResponseProcessor, TelemetryData } from './intents';
import { ConversationalBaseTelemetryData, createTelemetryWithId, sendModelMessageTelemetry } from './telemetry';

export interface IDefaultIntentRequestHandlerOptions {
	maxToolCallIterations: number;
	/**
	 * Whether to ask the user if they want to continue when the tool call limit
	 * is exceeded. Defaults to true.
	 */
	confirmOnMaxToolIterations?: boolean;
	temperature?: number;
	overrideRequestLocation?: ChatLocation;
	hideRateLimitTimeEstimate?: boolean;
}

/*
* Handles a single chat-request via an intent-invocation.
*/
export class DefaultIntentRequestHandler {

	private readonly turn: Turn;

	private _editSurvivalTracker: IEditSurvivalTrackingSession = new NullEditSurvivalTrackingSession();
	private _loop!: DefaultToolCallingLoop;

	constructor(
		private readonly intent: IIntent,
		private readonly conversation: Conversation,
		protected readonly request: ChatRequest,
		protected readonly stream: ChatResponseStream,
		private readonly token: CancellationToken,
		protected readonly documentContext: IDocumentContext | undefined,
		private readonly location: ChatLocation,
		private readonly chatTelemetryBuilder: ChatTelemetryBuilder,
		private readonly handlerOptions: IDefaultIntentRequestHandlerOptions = { maxToolCallIterations: 15 },
		private readonly onPaused: Event<boolean>, // todo: use a PauseController instead
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConversationOptions private readonly options: IConversationOptions,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@ISurveyService private readonly _surveyService: ISurveyService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IEditSurvivalTrackerService private readonly _editSurvivalTrackerService: IEditSurvivalTrackerService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IChatHookService private readonly _chatHookService: IChatHookService,
	) {
		// Initialize properties
		this.turn = conversation.getLatestTurn();
	}

	async getResult(): Promise<ChatResult> {
		if (isToolCallLimitCancellation(this.request)) {
			// Just some friendly text instead of an empty message on cancellation:
			this.stream.markdown(l10n.t("Let me know if there's anything else I can help with!"));
			return {};
		}

		try {
			if (this.token.isCancellationRequested) {
				return CanceledResult;
			}

			this._logService.trace('Processing intent');
			const intentInvocation = await this.intent.invoke({ location: this.location, documentContext: this.documentContext, request: this.request });
			if (this.token.isCancellationRequested) {
				return CanceledResult;
			}
			this._logService.trace('Processed intent');

			this.turn.setMetadata(new IntentInvocationMetadata(intentInvocation));

			const confirmationResult = await this.handleConfirmationsIfNeeded();
			if (confirmationResult) {
				return confirmationResult;
			}

			// For subagent requests, use the subAgentInvocationId as the session ID.
			// This enables explicit linking between the parent's runSubagent tool call and the subagent trajectory.
			// For main requests, use the VS Code chat sessionId directly as the trajectory session ID.
			const capturingToken = new CapturingToken(
				this.request.prompt,
				'comment',
				false,
				false,
				this.request.subAgentInvocationId,
				this.request.subAgentName,
				this.request.sessionId,
			);

			// Execute SubagentStart hook for subagent requests (runSubagent tool invocations)
			if (this.request.subAgentInvocationId) {
				const agentId = this.request.subAgentInvocationId;
				const agentType = this.request.subAgentName ?? 'runSubagent';
				this._logService.trace(`[DefaultIntentRequestHandler] Executing SubagentStart hook: agentId=${agentId}, agentType=${agentType}`);
				try {
					const startHookResults = await this._chatHookService.executeHook('SubagentStart', {
						toolInvocationToken: this.request.toolInvocationToken,
						input: { agent_id: agentId, agent_type: agentType } satisfies SubagentStartHookInput
					}, this.token);
					for (const result of startHookResults) {
						if (result.success === true) {
							const output = result.output;
							if (typeof output === 'object' && output !== null) {
								const hookOutput = output as SubagentStartHookOutput;
								if (hookOutput.additionalContext) {
									this._logService.trace(`[DefaultIntentRequestHandler] SubagentStart hook provided context: ${hookOutput.additionalContext.substring(0, 100)}...`);
								}
							}
						} else if (result.success === false) {
							const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
							this._logService.error(`[DefaultIntentRequestHandler] SubagentStart hook error: ${errorMessage}`);
						}
					}
				} catch (error) {
					this._logService.error('[DefaultIntentRequestHandler] Error executing SubagentStart hook', error);
				}
			}

			// Track SubagentStop hook state for subagent requests
			let subagentStopHookActive = false;
			let resultDetails: IInternalRequestResult;

			// Run the tool calling loop with SubagentStop hook integration for subagent requests
			while (true) {
				resultDetails = await this._requestLogger.captureInvocation(capturingToken, () => this.runWithToolCalling(intentInvocation));

				// Execute SubagentStop hook for subagent requests before returning
				if (this.request.subAgentInvocationId) {
					const agentId = this.request.subAgentInvocationId;
					const agentType = this.request.subAgentName ?? 'runSubagent';
					this._logService.trace(`[DefaultIntentRequestHandler] Executing SubagentStop hook: agentId=${agentId}, agentType=${agentType}, stop_hook_active=${subagentStopHookActive}`);
					try {
						const stopHookResults = await this._chatHookService.executeHook('SubagentStop', {
							toolInvocationToken: this.request.toolInvocationToken,
							input: { agent_id: agentId, agent_type: agentType, stop_hook_active: subagentStopHookActive } satisfies SubagentStopHookInput
						}, this.token);
						let shouldContinue = false;
						let blockReason: string | undefined;
						for (const result of stopHookResults) {
							if (result.success === true) {
								const output = result.output;
								if (typeof output === 'object' && output !== null) {
									const hookOutput = output as SubagentStopHookOutput;
									this._logService.trace(`[DefaultIntentRequestHandler] Checking SubagentStop hook output: decision=${hookOutput.decision}, reason=${hookOutput.reason}`);
									if (hookOutput.decision === 'block' && hookOutput.reason) {
										this._logService.trace(`[DefaultIntentRequestHandler] SubagentStop hook blocked: ${hookOutput.reason}`);
										shouldContinue = true;
										blockReason = hookOutput.reason;
										break;
									}
								}
							} else if (result.success === false) {
								const errorMessage = typeof result.output === 'string' ? result.output : 'Unknown error';
								this._logService.error(`[DefaultIntentRequestHandler] SubagentStop hook error: ${errorMessage}`);
							}
						}
						if (shouldContinue && blockReason) {
							this.stream.warning(l10n.t('Subagent stop hook: {0}', blockReason));
							this._logService.info(`[DefaultIntentRequestHandler] SubagentStop hook blocked, continuing with reason: ${blockReason}`);
							subagentStopHookActive = true;
							continue;
						}
					} catch (error) {
						this._logService.error('[DefaultIntentRequestHandler] Error executing SubagentStop hook', error);
					}
				}
				break;
			}

			let chatResult = resultDetails.chatResult || {};
			this._surveyService.signalUsage(`${this.location === ChatLocation.Editor ? 'inline' : 'panel'}.${this.intent.id}`, this.documentContext?.document.languageId);

			const responseMessage = resultDetails.toolCallRounds.at(-1)?.response ?? '';
			const metadataFragment: Partial<IResultMetadata> = {
				toolCallRounds: resultDetails.toolCallRounds,
				toolCallResults: this._collectRelevantToolCallResults(resultDetails.toolCallRounds, resultDetails.toolCallResults),
			};
			mixin(chatResult, { metadata: metadataFragment }, true);
			const baseModelTelemetry = createTelemetryWithId();
			chatResult = await this.processResult(resultDetails.response, responseMessage, chatResult, metadataFragment, baseModelTelemetry, resultDetails.toolCallRounds);
			if (chatResult.errorDetails && intentInvocation.modifyErrorDetails) {
				chatResult.errorDetails = intentInvocation.modifyErrorDetails(chatResult.errorDetails, resultDetails.response);
			}

			if (resultDetails.hadIgnoredFiles) {
				this.stream.markdown(HAS_IGNORED_FILES_MESSAGE);
			}

			return chatResult;
		} catch (err) {
			if (err instanceof ToolCallCancelledError) {
				this.turn.setResponse(TurnStatus.Cancelled, { message: err.message, type: 'meta' }, undefined, {});
				return {};
			} else if (isCancellationError(err)) {
				return CanceledResult;
			} else if (err instanceof EmptyPromptError) {
				return {};
			}

			this._logService.error(err);
			this._telemetryService.sendGHTelemetryException(err, 'Error');
			const errorMessage = (<Error>err).message;
			const chatResult = { errorDetails: { message: errorMessage } };
			this.turn.setResponse(TurnStatus.Error, { message: errorMessage, type: 'meta' }, undefined, chatResult);
			return chatResult;
		}
	}

	private _collectRelevantToolCallResults(toolCallRounds: IToolCallRound[], toolCallResults: Record<string, LanguageModelToolResult2>): Record<string, LanguageModelToolResult2> | undefined {
		const resultsUsedInThisTurn: Record<string, LanguageModelToolResult2> = {};
		for (const round of toolCallRounds) {
			for (const toolCall of round.toolCalls) {
				resultsUsedInThisTurn[toolCall.id] = toolCallResults[toolCall.id];
			}
		}

		return Object.keys(resultsUsedInThisTurn).length ? resultsUsedInThisTurn : undefined;
	}

	private _sendInitialChatReferences({ result: buildPromptResult }: IToolCallingBuiltPromptEvent) {
		const [includedVariableReferences, ignoredVariableReferences] = [getUniqueReferences(buildPromptResult.references), getUniqueReferences(buildPromptResult.omittedReferences)].map((refs) => refs.reduce((acc, ref) => {
			if ('variableName' in ref.anchor) {
				acc.add(ref.anchor.variableName);
			}
			return acc;
		}, new Set<string>()));
		for (const reference of buildPromptResult.references) {
			// Report variables which were partially sent to the model
			const options = reference.options ?? ('variableName' in reference.anchor && ignoredVariableReferences.has(reference.anchor.variableName)
				? { status: { kind: 2, description: l10n.t('Part of this attachment was not sent to the model due to context window limitations.') } }
				: undefined);
			if (!reference.options?.isFromTool) {
				// References reported by a tool result will be shown in a separate list, don't need to be reported as references
				this.stream.reference2(reference.anchor, undefined, options);
			}
		}
		for (const omittedReference of buildPromptResult.omittedReferences) {
			if ('variableName' in omittedReference.anchor && !includedVariableReferences.has(omittedReference.anchor.variableName)) {
				this.stream.reference2(omittedReference.anchor, undefined, { status: { kind: 3, description: l10n.t('This attachment was not sent to the model due to context window limitations.') } });
			}
		}
	}

	private makeResponseStreamParticipants(intentInvocation: IIntentInvocation): ResponseStreamParticipant[] {
		const participants: ResponseStreamParticipant[] = [];

		// 1. Tracking of code blocks. Currently used in stests. todo@connor4312:
		// can we simplify this so it's not used otherwise?
		participants.push(stream => {
			const codeBlockTrackingResponseStream = this._instantiationService.createInstance(CodeBlockTrackingChatResponseStream, stream, intentInvocation.codeblocksRepresentEdits);
			return ChatResponseStreamImpl.spy(
				codeBlockTrackingResponseStream,
				v => v,
				() => {
					const codeBlocksMetaData = codeBlockTrackingResponseStream.finish();
					this.turn.setMetadata(codeBlocksMetaData);
				}
			);
		});

		// 2. Track the survival of edits made in the editor
		if (this.documentContext && this.location === ChatLocation.Editor) {
			participants.push(stream => {
				const firstTurnWithAIEditCollector = this.conversation.turns.find(turn => turn.getMetadata(CopilotInteractiveEditorResponse)?.editSurvivalTracker);
				this._editSurvivalTracker = firstTurnWithAIEditCollector?.getMetadata(CopilotInteractiveEditorResponse)?.editSurvivalTracker ?? this._editSurvivalTrackerService.initialize(this.documentContext!.document.document);
				return ChatResponseStreamImpl.spy(stream, value => {
					if (value instanceof ChatResponseTextEditPart) {
						this._editSurvivalTracker.collectAIEdits(value.edits);
					}
				});
			});
		}


		// 3. Track the survival of other(?) interactions
		// todo@connor4312: can these two streams be combined?
		const interactionOutcomeComputer = new InteractionOutcomeComputer(this.documentContext?.document.uri);
		participants.push(stream => interactionOutcomeComputer.spyOnStream(stream));

		// 4. Linkify the stream unless told otherwise, or if this is a subagent request
		if (!intentInvocation.linkification?.disable && !this.request.subAgentInvocationId) {
			participants.push(stream => {
				const linkStream = this._instantiationService.createInstance(ResponseStreamWithLinkification, { requestId: this.turn.id, references: this.turn.references }, stream, intentInvocation.linkification?.additionaLinkifiers ?? [], this.token);
				return ChatResponseStreamImpl.spy(linkStream, p => p, () => {
					this._loop.telemetry.markAddedLinks(linkStream.totalAddedLinkCount);
				});
			});
		}

		// 5. General telemetry on emitted components
		participants.push(stream => ChatResponseStreamImpl.spy(stream, (part) => {
			if (part instanceof ChatResponseMarkdownPart) {
				this._loop.telemetry.markEmittedMarkdown(part.value);
			}
			if (part instanceof ChatResponseTextEditPart) {
				this._loop.telemetry.markEmittedEdits(part.uri, part.edits);
			}
		}));

		return participants;
	}

	private async _onDidReceiveResponse({ response, toolCalls, interactionOutcome }: IToolCallingResponseEvent) {
		const responseMessage = (response.type === ChatFetchResponseType.Success ? response.value : '');
		await this._loop.telemetry.sendTelemetry(response.requestId, response.type, responseMessage, interactionOutcome.interactionOutcome, toolCalls);

		if (this.documentContext) {
			this.turn.setMetadata(new CopilotInteractiveEditorResponse(
				interactionOutcome.store,
				{ ...this.documentContext, intent: this.intent, query: this.request.prompt },
				this.chatTelemetryBuilder.telemetryMessageId,
				this._loop.telemetry,
				this._editSurvivalTracker,
			));

			const documentText = this.documentContext?.document.getText();
			this.turn.setMetadata(new RequestDebugInformation(
				this.documentContext.document.uri,
				this.intent.id,
				this.documentContext.document.languageId,
				documentText!,
				this.request.prompt,
				this.documentContext.selection
			));
		}
	}

	private async runWithToolCalling(intentInvocation: IIntentInvocation): Promise<IInternalRequestResult> {
		const store = new DisposableStore();
		const loop = this._loop = store.add(this._instantiationService.createInstance(
			DefaultToolCallingLoop,
			{
				conversation: this.conversation,
				intent: this.intent,
				invocation: intentInvocation,
				toolCallLimit: this.handlerOptions.maxToolCallIterations,
				onHitToolCallLimit: this.handlerOptions.confirmOnMaxToolIterations !== false
					? ToolCallLimitBehavior.Confirm : ToolCallLimitBehavior.Stop,
				request: this.request,
				documentContext: this.documentContext,
				streamParticipants: this.makeResponseStreamParticipants(intentInvocation),
				temperature: this.handlerOptions.temperature ?? this.options.temperature,
				location: this.location,
				overrideRequestLocation: this.handlerOptions.overrideRequestLocation,
				interactionContext: this.documentContext?.document.uri,
				responseProcessor: typeof intentInvocation.processResponse === 'function' ? intentInvocation as IResponseProcessor : undefined,
			},
			this.chatTelemetryBuilder,
		));

		store.add(Event.once(loop.onDidBuildPrompt)(this._sendInitialChatReferences, this));

		// We need to wait for all response handlers to finish before
		// we can dispose the store. This is because the telemetry machine
		// still needs the tokenizers to count tokens. There was a case in vitests
		// in which the store, and the tokenizers, were disposed before the telemetry
		// machine could count the tokens, which resulted in an error.
		// src/extension/prompt/node/chatParticipantTelemetry.ts#L521-L522
		//
		// cc @lramos15
		const responseHandlers: Promise<unknown>[] = [];
		store.add(loop.onDidReceiveResponse(res => {
			const promise = this._onDidReceiveResponse(res);
			responseHandlers.push(promise);
			return promise;
		}, this));

		const pauseCtrl = store.add(new PauseController(this.onPaused, this.token));

		try {
			try {
				await this._chatHookService.executeHook('UserPromptSubmit', { toolInvocationToken: this.request.toolInvocationToken, input: { prompt: this.request.prompt } satisfies UserPromptSubmitHookInput });
			} catch (error) {
				this._logService.error('[DefaultIntentRequestHandler] Error executing UserPromptSubmit hook', error);
			}
			const result = await loop.run(this.stream, pauseCtrl);
			if (!result.round.toolCalls.length || result.response.type !== ChatFetchResponseType.Success) {
				loop.telemetry.sendToolCallingTelemetry(result.toolCallRounds, result.availableTools, this.token.isCancellationRequested ? 'cancelled' : result.response.type);
			}
			result.chatResult ??= {};
			if ((result.chatResult.metadata as IResultMetadata)?.maxToolCallsExceeded) {
				loop.telemetry.sendToolCallingTelemetry(result.toolCallRounds, result.availableTools, 'maxToolCalls');
			}

			// TODO need proper typing for all chat metadata and a better pattern to build it up from random places
			result.chatResult = this.resultWithMetadatas(result.chatResult);
			return { ...result, lastRequestTelemetry: loop.telemetry };
		} finally {
			await Promise.allSettled(responseHandlers);
			store.dispose();
		}
	}

	private resultWithMetadatas(chatResult: ChatResult | undefined): ChatResult | undefined {
		const codeBlocks = this.turn.getMetadata(CodeBlocksMetadata);
		const summarizedConversationHistory = this.turn.getMetadata(SummarizedConversationHistoryMetadata);
		const renderedUserMessageMetadata = this.turn.getMetadata(RenderedUserMessageMetadata);
		const globalContextMetadata = this.turn.getMetadata(GlobalContextMessageMetadata);
		const anthropicTokenUsageMetadata = this.turn.getMetadata(AnthropicTokenUsageMetadata);
		return codeBlocks || summarizedConversationHistory || renderedUserMessageMetadata || globalContextMetadata || anthropicTokenUsageMetadata ?
			{
				...chatResult,
				metadata: {
					...chatResult?.metadata,
					...codeBlocks,
					...summarizedConversationHistory && { summary: summarizedConversationHistory },
					...renderedUserMessageMetadata,
					...globalContextMetadata,
					...anthropicTokenUsageMetadata,
				} satisfies Partial<IResultMetadata>,
			} : chatResult;
	}

	private async handleConfirmationsIfNeeded(): Promise<ChatResult | undefined> {
		const intentInvocation = this.turn.getMetadata(IntentInvocationMetadata)?.value;
		assertType(intentInvocation);
		if ((this.request.acceptedConfirmationData?.length || this.request.rejectedConfirmationData?.length) && intentInvocation.confirmationHandler) {
			await intentInvocation.confirmationHandler(this.request.acceptedConfirmationData, this.request.rejectedConfirmationData, this.stream);
			return {};
		}
	}

	private async processSuccessfulFetchResult(appliedText: string, requestId: string, chatResult: ChatResult, baseModelTelemetry: ConversationalBaseTelemetryData, rounds: IToolCallRound[]): Promise<ChatResult> {
		if (appliedText.length === 0 && !rounds.some(r => r.toolCalls.length)) {
			const message = l10n.t('The model unexpectedly did not return a response. Request ID: {0}', requestId);
			this.turn.setResponse(TurnStatus.Error, { type: 'meta', message }, baseModelTelemetry.properties.messageId, chatResult);
			return {
				errorDetails: {
					message
				},
			};
		}

		this.turn.setResponse(TurnStatus.Success, { type: 'model', message: appliedText }, baseModelTelemetry.properties.messageId, chatResult);
		baseModelTelemetry.markAsDisplayed();
		sendModelMessageTelemetry(
			this._telemetryService,
			this.conversation,
			this.location,
			appliedText,
			requestId,
			this.documentContext?.document,
			baseModelTelemetry,
			this.getModeName()
		);

		return chatResult;
	}

	private getModeName(): string {
		return this.request.modeInstructions2 ? 'custom' :
			this.intent.id === 'editAgent' ? 'agent' :
				(this.intent.id === 'edit' || this.intent.id === 'edit2') ? 'edit' :
					'ask';
	}

	private processOffTopicFetchResult(baseModelTelemetry: ConversationalBaseTelemetryData): ChatResult {
		// Create starting off topic telemetry and mark event as issued and displayed
		this.stream.markdown(this.options.rejectionMessage);
		this.turn.setResponse(TurnStatus.OffTopic, { message: this.options.rejectionMessage, type: 'offtopic-detection' }, baseModelTelemetry.properties.messageId, {});
		return {};
	}

	private async processResult(fetchResult: ChatResponse, responseMessage: string, chatResult: ChatResult | void, metadataFragment: Partial<IResultMetadata>, baseModelTelemetry: ConversationalBaseTelemetryData, rounds: IToolCallRound[]): Promise<ChatResult> {
		switch (fetchResult.type) {
			case ChatFetchResponseType.Success:
				return await this.processSuccessfulFetchResult(responseMessage, fetchResult.requestId, chatResult ?? {}, baseModelTelemetry, rounds);
			case ChatFetchResponseType.OffTopic:
				return this.processOffTopicFetchResult(baseModelTelemetry);
			case ChatFetchResponseType.Canceled: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Cancelled, { message: errorDetails.message, type: 'user' }, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.QuotaExceeded:
			case ChatFetchResponseType.RateLimited: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan, this.handlerOptions.hideRateLimitTimeEstimate);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.BadRequest:
			case ChatFetchResponseType.NetworkError:
			case ChatFetchResponseType.Failed: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, { message: errorDetails.message, type: 'server' }, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.Filtered: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: { ...metadataFragment, filterReason: fetchResult.category } };
				this.turn.setResponse(TurnStatus.Filtered, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.PromptFiltered: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: { ...metadataFragment, filterReason: FilterReason.Prompt } };
				this.turn.setResponse(TurnStatus.PromptFiltered, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.AgentUnauthorized: {
				const chatResult = {};
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.AgentFailedDependency: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.Length: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.NotFound: // before we had `NotFound`, it would fall into Unknown, so behavior should be consistent
			case ChatFetchResponseType.Unknown: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.ExtensionBlocked: {
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				// This shouldn't happen, only 3rd party extensions should be blocked
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.InvalidStatefulMarker:
				throw new Error('unreachable'); // retried within the endpoint
		}
	}
}

interface IInternalRequestResult {
	response: ChatResponse;
	round: IToolCallRound;
	chatResult?: ChatResult; // TODO should just be metadata
	hadIgnoredFiles: boolean;
	lastRequestMessages: Raw.ChatMessage[];
	lastRequestTelemetry: ChatTelemetry;
}

interface IDefaultToolLoopOptions extends IToolCallingLoopOptions {
	invocation: IIntentInvocation;
	intent: IIntent;
	documentContext: IDocumentContext | undefined;
	location: ChatLocation;
	temperature: number;
	overrideRequestLocation?: ChatLocation;
}

class DefaultToolCallingLoop extends ToolCallingLoop<IDefaultToolLoopOptions> {
	public telemetry!: ChatTelemetry;
	private toolGrouping?: IToolGrouping;

	constructor(
		options: IDefaultToolLoopOptions,
		telemetryBuilder: ChatTelemetryBuilder,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IToolGroupingService private readonly toolGroupingService: IToolGroupingService,
		@ICopilotTokenStore private readonly _copilotTokenStore: ICopilotTokenStore,
		@IChatHookService chatHookService: IChatHookService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService, configurationService, experimentationService, chatHookService);

		this._register(this.onDidBuildPrompt(({ result, tools, promptTokenLength, toolTokenCount }) => {
			if (result.metadata.get(SummarizedConversationHistoryMetadata)) {
				this.toolGrouping?.didInvalidateCache();
			}

			this.telemetry = telemetryBuilder.makeRequest(
				options.intent!,
				options.location,
				options.conversation,
				result.messages,
				promptTokenLength,
				result.references,
				options.invocation.endpoint,
				result.metadata.getAll(TelemetryData) ?? [],
				tools.length,
				toolTokenCount
			);
		}));

		this._register(this.onDidReceiveResponse(() => {
			this.toolGrouping?.didTakeTurn();
		}));
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): Mutable<IBuildPromptContext> {
		const context = super.createPromptContext(availableTools, outputStream);
		this._handleVirtualCalls(context);

		const extraVars = this.options.invocation.getAdditionalVariables?.(context);
		if (extraVars?.hasVariables()) {
			return {
				...context,
				chatVariables: ChatVariablesCollection.merge(context.chatVariables, extraVars),
			};
		}

		return context;
	}

	/**
	 * Temporary logic to evaluate the efficacy of virtual tool grouping. Enabled
	 * only for internal users so as to not cost premium requests for real users.
	 *
	 * 1. Wait until we get the first MCP (external) tool call for a conversation.
	 * 2. Trigger virtual tool grouping
	 * 3. Replay that same request with virtual tool grouping enabled
	 * 4. Ensure the group containing the tool call is expanded
	 */
	private _didParallelToolCallLoop?: boolean;
	private async _doMirroredCallWithVirtualTools(delta: IResponseDelta, messages: Raw.ChatMessage[], requestOptions: OptionalChatRequestParams) {
		const shouldDo = !this._didParallelToolCallLoop
			&& this._copilotTokenStore.copilotToken?.isInternal;
		if (!shouldDo) {
			return;
		}

		const candidateCall = delta.copilotToolCalls?.find(tc => tc.name.startsWith('mcp_'));
		if (!candidateCall) {
			return;
		}

		this._didParallelToolCallLoop = true;
		if (this._experimentationService.getTreatmentVariable<boolean>('copilotchat.noParallelToolLoop')) {
			return;
		}

		const token = CancellationToken.None;
		const allTools = await this.options.invocation.getAvailableTools?.() ?? [];
		const grouping = this.toolGroupingService.create(this.options.conversation.sessionId, allTools);
		const computed = await grouping.compute(this.options.request.prompt, token);

		const container = grouping.getContainerFor(candidateCall.name);

		let state = container ? (container.isExpanded ? 'defaultExpanded' : 'collapsed') : 'topLevel';
		if (state === 'collapsed') {
			await this.options.invocation.endpoint.makeChatRequest(
				`${ChatLocation.toStringShorter(this.options.location)}/${this.options.intent?.id}/virtualParallelEval`,
				messages,
				(_text, _index, delta) => {
					if (delta.copilotToolCalls?.some(tc => tc.name === container!.name)) {
						state = 'expanded';
						return Promise.resolve(1);
					}
					return Promise.resolve(undefined);
				},
				token,
				this.options.overrideRequestLocation ?? this.options.location,
				undefined,
				{
					...requestOptions,
					tools: normalizeToolSchema(
						this.options.invocation.endpoint.family,
						computed.map(tool => ({
							type: 'function',
							function: {
								name: tool.name,
								description: tool.description,
								parameters: tool.inputSchema && Object.keys(tool.inputSchema).length ? tool.inputSchema : undefined
							},
						})),
						(tool, rule) => {
							this._logService.warn(`Tool ${tool} failed validation: ${rule}`);
						},
					),
					temperature: this.calculateTemperature(),
				},
				false, // The first tool call is user initiated and then the rest are just considered part of the loop
			);
		}


		/* __GDPR__
			"virtualTools.parallelCall" : {
				"owner": "connor4312",
				"comment": "Reports information about the generation of virtual tools.",
				"toolCallName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Name of the original tool call" },
				"toolGroupName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Name of the containing tool group" },
				"toolGroupState": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If/how the tool call was expanded" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('virtualTools.parallelCall', {
			toolCallName: candidateCall.name,
			toolGroupName: container?.name,
			toolGroupState: state,
		});
	}

	private _handleVirtualCalls(context: Mutable<IBuildPromptContext>) {
		if (!this.toolGrouping) {
			return;
		}

		for (const call of context.toolCallRounds?.at(-1)?.toolCalls || Iterable.empty()) {
			if (context.toolCallResults?.[call.id]) {
				continue;
			}
			const expanded = this.toolGrouping.didCall(context.toolCallRounds!.length, call.name);
			if (expanded) {
				context.toolCallResults ??= {};
				context.toolCallResults[call.id] = expanded;
			}
		}
	}

	protected override async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const buildPromptResult = await this.options.invocation.buildPrompt(buildPromptContext, progress, token);
		this.fixMessageNames(buildPromptResult.messages);
		return buildPromptResult;
	}

	protected override async fetch(opts: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const messageSourcePrefix = this.options.location === ChatLocation.Editor ? 'inline' : 'chat';
		const debugName = this.options.request.subAgentInvocationId ?
			`tool/runSubagent${this.options.request.subAgentName ? `-${this.options.request.subAgentName}` : ''}` :
			`${ChatLocation.toStringShorter(this.options.location)}/${this.options.intent?.id}`;
		return this.options.invocation.endpoint.makeChatRequest2({
			...opts,
			debugName,
			finishedCb: (text, index, delta) => {
				this.telemetry.markReceivedToken();
				this._doMirroredCallWithVirtualTools(delta, opts.messages, opts.requestOptions!);
				return opts.finishedCb!(text, index, delta);
			},
			location: this.options.overrideRequestLocation ?? this.options.location,
			requestOptions: {
				...opts.requestOptions,
				tools: normalizeToolSchema(
					this.options.invocation.endpoint.family,
					opts.requestOptions.tools,
					(tool, rule) => {
						this._logService.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
				temperature: this.calculateTemperature(),
			},
			telemetryProperties: {
				messageId: this.telemetry.telemetryMessageId,
				conversationId: this.options.conversation.sessionId,
				messageSource: this.options.intent?.id && this.options.intent.id !== UnknownIntent.ID ? `${messageSourcePrefix}.${this.options.intent.id}` : `${messageSourcePrefix}.user`,
				subType: this.options.request.subAgentInvocationId ? `subagent` : undefined,
				parentRequestId: this.options.request.parentRequestId,
			},
			enableRetryOnFilter: true
		}, token);
	}

	protected override async getAvailableTools(outputStream: ChatResponseStream | undefined, token: CancellationToken): Promise<LanguageModelToolInformation[]> {
		const tools = await this.options.invocation.getAvailableTools?.() ?? [];

		// Skip tool grouping when Anthropic tool search is enabled
		if (isAnthropicFamily(this.options.invocation.endpoint) && isAnthropicToolSearchEnabled(this.options.invocation.endpoint, this._configurationService, this._experimentationService)) {
			return tools;
		}

		if (this.toolGrouping) {
			this.toolGrouping.tools = tools;
		} else {
			this.toolGrouping = this.toolGroupingService.create(this.options.conversation.sessionId, tools);
			for (const ref of this.options.request.toolReferences) {
				this.toolGrouping.ensureExpanded(ref.name);
			}
		}

		const computePromise = this.toolGrouping.compute(this.options.request.prompt, token);		// Show progress if this takes a moment...
		const timeout = setTimeout(() => {
			outputStream?.progress(l10n.t('Optimizing tool selection...'), async () => {
				await computePromise;
			});
		}, 1000);

		try {
			return await computePromise;
		} finally {
			clearTimeout(timeout);
		}
	}

	private fixMessageNames(messages: Raw.ChatMessage[]): void {
		messages.forEach(m => {
			if (m.role !== Raw.ChatRole.System && 'name' in m && m.name === this.options.intent?.id) {
				// Assistant messages from the current intent should not have 'name' set.
				// It's not well-documented how this works in OpenAI models but this seems to be the expectation
				m.name = undefined;
			}
		});
	}

	private calculateTemperature(): number {
		if (this.options.request.attempt > 0) {
			return Math.min(
				this.options.temperature * (this.options.request.attempt + 1),
				2 /* MAX temperature - https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature */
			);
		} else {
			return this.options.temperature;
		}
	}
}

interface IInternalRequestResult extends IToolCallLoopResult {
	lastRequestTelemetry: ChatTelemetry;
}
