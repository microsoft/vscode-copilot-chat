/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { CanceledResult, ChatFetchResponseType, ChatLocation, ChatResponse, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEditSurvivalTrackerService } from '../../../platform/editSurvivalTracking/common/editSurvivalTrackerService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { isNonEmptyArray } from '../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { Event } from '../../../util/vs/base/common/event';
import { assertType } from '../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditorData, ChatResponseTextEditPart, LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { Intent } from '../../common/constants';
import { getAgentTools } from '../../intents/node/agentIntent';
import { IIntentService } from '../../intents/node/intentService';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IToolCall } from '../../prompt/common/intents';
import { ToolCallRound } from '../../prompt/common/toolCallRound';
import { ChatTelemetryBuilder, InlineChatTelemetry } from '../../prompt/node/chatParticipantTelemetry';
import { IntentInvocationMetadata } from '../../prompt/node/conversation';
import { DefaultIntentRequestHandler } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent } from '../../prompt/node/intents';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { InlineChat2Prompt } from '../../prompts/node/inline/inlineChat2Prompt';
import { ToolName } from '../../tools/common/toolNames';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { CopilotToolMode } from '../../tools/common/toolsRegistry';
import { isToolValidationError, isValidatedToolInput, IToolsService } from '../../tools/common/toolsService';
import { CopilotInteractiveEditorResponse, InteractionOutcomeComputer } from './promptCraftingTypes';

const INLINE_CHAT_EXIT_TOOL_NAME = 'inline_chat_exit';

export class InlineChatIntent implements IIntent {

	static readonly ID = Intent.InlineChat;

	private static readonly _EDIT_TOOLS = new Set<string>([
		ToolName.ApplyPatch,
		ToolName.EditFile,
		ToolName.ReplaceString,
		ToolName.MultiReplaceString,
	]);

	readonly id = InlineChatIntent.ID;

	readonly locations = [ChatLocation.Editor];

	readonly description: string = '';

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IEditSurvivalTrackerService private readonly _editSurvivalTrackerService: IEditSurvivalTrackerService,
		@IIntentService private readonly _intentService: IIntentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, _agentName: string, _location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {

		assertType(request.location2 instanceof ChatRequestEditorData);
		assertType(documentContext);

		if (await this._ignoreService.isCopilotIgnored(request.location2.document.uri, token)) {
			return {
				errorDetails: {
					message: l10n.t('inlineChat.ignored', "Copilot is disabled for this file."),
				}
			};
		}

		const endpoint = await this._endpointProvider.getChatEndpoint(request);

		if (!endpoint.supportsToolCalls) {
			return {
				errorDetails: {
					message: l10n.t('inlineChat.model', "{0} cannot be used for inline chat", endpoint.name),
				}
			};
		}

		if (this._configurationService.getNonExtensionConfig('inlineChat.enableV2')) {
			return this._handleRequestWithEditTools(endpoint, conversation, request, stream, token, documentContext, chatTelemetry);
		} else {
			return this._handleRequestWithOldWorld(conversation, request, stream, token, documentContext, chatTelemetry, onPaused);
		}
	}

	// --- OLD world

	private async _handleRequestWithOldWorld(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {
		// OLD world
		let didEmitEdits = false;
		stream = ChatResponseStreamImpl.spy(stream, part => {
			if (part instanceof ChatResponseTextEditPart) {
				didEmitEdits = true;
			}
		});

		const intent = await this._selectIntent(conversation.turns, documentContext, request);
		const handler = this._instantiationService.createInstance(DefaultIntentRequestHandler, intent, conversation, request, stream, token, documentContext, ChatLocation.Editor, chatTelemetry, undefined, onPaused);
		const result = await handler.getResult();

		if (!didEmitEdits) {
			// BAILOUT: when no edits were emitted, invoke the exit tool manually
			await this._toolsService.invokeTool(INLINE_CHAT_EXIT_TOOL_NAME, { toolInvocationToken: request.toolInvocationToken, input: undefined }, token);
		}
		return result;
	}

	private async _selectIntent(history: readonly Turn[], documentContext: IDocumentContext, request: vscode.ChatRequest): Promise<IIntent> {

		if (request.command) {
			const result = this._intentService.getIntent(request.command, ChatLocation.Editor);
			if (result) {
				return result;
			}
		}

		let preferredIntent: Intent | undefined;
		if (documentContext && request.attempt === 0 && history.length === 1) {
			if (documentContext.selection.isEmpty && documentContext.document.lineAt(documentContext.selection.start.line).text.trim() === '') {
				preferredIntent = Intent.Generate;
			} else if (!documentContext.selection.isEmpty && documentContext.selection.start.line !== documentContext.selection.end.line) {
				preferredIntent = Intent.Edit;
			}
		}
		if (preferredIntent) {
			return this._intentService.getIntent(preferredIntent, ChatLocation.Editor) ?? this._intentService.unknownIntent;
		}
		return this._intentService.unknownIntent;
	}

	// --- NEW world

	async _handleRequestWithEditTools(endpoint: IChatEndpoint, conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext, chatTelemetry: ChatTelemetryBuilder): Promise<vscode.ChatResult> {
		assertType(request.location2 instanceof ChatRequestEditorData);
		assertType(documentContext);

		const outcomeComputer = new InteractionOutcomeComputer(request.location2.document.uri);
		const editSurvivalTracker = this._editSurvivalTrackerService.initialize(request.location2.document);

		let availableTools: vscode.LanguageModelToolInformation[] | undefined;
		try {
			availableTools = await this._getAvailableTools(request);
		} catch {
			return {
				errorDetails: {
					message: l10n.t('Sorry, looks like inline chat lost its tools for the job.'),
				}
			};
		}

		const editAttempts: [IToolCall, vscode.ExtendedLanguageModelToolResult][] = [];
		const toolCallRounds: ToolCallRound[] = [];
		let telemetry: InlineChatTelemetry;
		let lastResponse: ChatResponse;

		while (true) {

			const renderer = PromptRenderer.create(this._instantiationService, endpoint, InlineChat2Prompt, {
				request,
				editAttempts,
				snapshotAtRequest: documentContext.document,
				data: request.location2,
				exitToolName: INLINE_CHAT_EXIT_TOOL_NAME,
			});

			const renderResult = await renderer.render(undefined, token, { trace: true });

			telemetry = chatTelemetry.makeRequest(this, ChatLocation.Editor, conversation, renderResult.messages, renderResult.tokenCount, renderResult.references, endpoint, [], availableTools.length);

			stream = ChatResponseStreamImpl.spy(stream, part => {
				if (part instanceof ChatResponseTextEditPart) {
					editSurvivalTracker.collectAIEdits(part.edits);
					telemetry.markEmittedEdits(part.uri, part.edits);
				}
			});

			stream = outcomeComputer.spyOnStream(stream);

			const result = await this._makeRequestAndRunTools(endpoint, request, stream, renderResult.messages, availableTools, telemetry, token);

			lastResponse = result.fetchResult;

			// telemetry
			{
				const responseText = lastResponse.type === ChatFetchResponseType.Success ? lastResponse.value : '';
				telemetry.sendTelemetry(
					lastResponse.requestId, lastResponse.type, responseText,
					outcomeComputer.interactionOutcome,
					result.toolCalls
				);

				toolCallRounds.push(ToolCallRound.create({
					response: responseText,
					toolCalls: result.toolCalls,
					toolInputRetry: editAttempts.length
				}));
			}

			if (result.failedEdits.length === 0 || token.isCancellationRequested) {
				// DONE
				break;
			}

			if (editAttempts.push(...result.failedEdits) > 5) {
				// TOO MANY FAILED ATTEMPTS
				this._logService.warn(`Aborting inline chat edit: too many failed edit attempts`);
				break;
			}
		}

		telemetry.sendToolCallingTelemetry(toolCallRounds, availableTools, token.isCancellationRequested ? 'cancelled' : lastResponse.type);

		if (token.isCancellationRequested) {
			return CanceledResult;
		}

		if (lastResponse.type !== ChatFetchResponseType.Success) {
			const details = getErrorDetailsFromChatFetchError(lastResponse, (await this._authenticationService.getCopilotToken()).copilotPlan);
			return {
				errorDetails: {
					message: details.message,
					responseIsFiltered: details.responseIsFiltered
				}
			};
		}

		// store metadata for telemetry sending
		const turn = conversation.getLatestTurn();
		turn.setMetadata(outcomeComputer.interactionOutcome);
		turn.setMetadata(new CopilotInteractiveEditorResponse(
			'ok', outcomeComputer.store,
			{ ...documentContext, query: request.prompt, intent: this },
			telemetry.telemetryMessageId, telemetry, editSurvivalTracker
		));
		turn.setMetadata(new IntentInvocationMetadata({ // UGLY fake intent invocation
			location: ChatLocation.Editor,
			intent: this,
			endpoint,
			buildPrompt: () => { throw new Error(); },
		}));

		return {};
	}

	private async _makeRequestAndRunTools(endpoint: IChatEndpoint, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, messages: Raw.ChatMessage[], inlineChatTools: vscode.LanguageModelToolInformation[], telemetry: InlineChatTelemetry, token: CancellationToken) {

		const requestOptions: IMakeChatRequestOptions['requestOptions'] = {
			tool_choice: 'auto',
			tools: normalizeToolSchema(
				endpoint.family,
				inlineChatTools.map(tool => ({
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
			)
		};

		const toolCalls: IToolCall[] = [];
		const failedEdits: [IToolCall, vscode.ExtendedLanguageModelToolResult][] = [];

		const fetchResult = await endpoint.makeChatRequest2({
			debugName: 'InlineChat2Intent',
			messages,
			userInitiatedRequest: true,
			location: ChatLocation.Editor,
			requestOptions,
			telemetryProperties: {
				messageId: telemetry.telemetryMessageId,
				conversationId: telemetry.sessionId,
				messageSource: this.id
			},
			finishedCb: async (_text, _index, delta) => {

				telemetry.markReceivedToken();

				if (!isNonEmptyArray(delta.copilotToolCalls)) {
					return undefined;
				}

				const exitToolCall = delta.copilotToolCalls.find(candidate => candidate.name === INLINE_CHAT_EXIT_TOOL_NAME);
				const copilotToolCalls = exitToolCall ? [exitToolCall] : delta.copilotToolCalls;

				for (const toolCall of copilotToolCalls) {

					toolCalls.push(toolCall);

					const validationResult = this._toolsService.validateToolInput(toolCall.name, toolCall.arguments);

					if (isToolValidationError(validationResult)) {
						this._logService.warn(`Tool ${toolCall.name} invocation failed validation: ${validationResult}`);
						failedEdits.push([toolCall, new LanguageModelToolResult([new LanguageModelTextPart(validationResult.error)])]);
						continue;
					}

					try {
						stream.progress(l10n.t('Applying edits...'));

						let input = isValidatedToolInput(validationResult)
							? validationResult.inputObj
							: JSON.parse(toolCall.arguments);

						const copilotTool = this._toolsService.getCopilotTool(toolCall.name as ToolName);
						if (copilotTool?.resolveInput) {
							input = await copilotTool.resolveInput(input, {
								request,
								stream,
								query: request.prompt,
								chatVariables: new ChatVariablesCollection([...request.references]),
								history: [],
							}, CopilotToolMode.FullContext);
						}

						const result = await this._toolsService.invokeTool(toolCall.name, {
							input,
							toolInvocationToken: request.toolInvocationToken,
						}, token) as vscode.ExtendedLanguageModelToolResult;

						if (result.hasError) {
							failedEdits.push([toolCall, result]);
							stream.progress(l10n.t('Looking not yet good, trying again...'));
						}

						this._logService.trace(`Tool ${toolCall.name} invocation result: ${JSON.stringify(result)}`);

					} catch (err) {
						this._logService.error(err, `Tool ${toolCall.name} invocation failed`);
						failedEdits.push([toolCall, new LanguageModelToolResult([new LanguageModelTextPart(toErrorMessage(err))])]);
					}
				}

				return undefined;
			}
		}, token);

		return { fetchResult, toolCalls, failedEdits };
	}

	private async _getAvailableTools(request: vscode.ChatRequest): Promise<vscode.LanguageModelToolInformation[]> {

		const exitTool = this._toolsService.getTool(INLINE_CHAT_EXIT_TOOL_NAME);
		if (!exitTool) {
			this._logService.error('MISSING inline chat exit tool');
			throw new Error();
		}

		// ALWAYS enable editing tools (only) and ignore what the client did send
		const fakeRequest: vscode.ChatRequest = {
			...request,
			tools: new Map(Array.from(InlineChatIntent._EDIT_TOOLS).map(toolName => [toolName, true] as const))
		};

		const agentTools = await this._instantiationService.invokeFunction(getAgentTools, fakeRequest);
		const editTools = agentTools.filter(tool => InlineChatIntent._EDIT_TOOLS.has(tool.name));

		if (editTools.length === 0) {
			this._logService.error('MISSING inline chat edit tools');
			throw new Error();
		}

		return [exitTool, ...editTools];
	}

	invoke(): Promise<never> {
		throw new TypeError();
	}
}
