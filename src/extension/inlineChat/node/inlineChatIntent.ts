/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ChatFetchResponseType, ChatLocation, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { isNonEmptyArray } from '../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { Event } from '../../../util/vs/base/common/event';
import { assertType } from '../../../util/vs/base/common/types';
import { localize } from '../../../util/vs/nls';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditorData } from '../../../vscodeTypes';
import { Intent } from '../../common/constants';
import { getAgentTools } from '../../intents/node/agentIntent';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation } from '../../prompt/common/conversation';
import { IToolCall } from '../../prompt/common/intents';
import { ToolCallRound } from '../../prompt/common/toolCallRound';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent } from '../../prompt/node/intents';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { InlineChat2Prompt } from '../../prompts/node/inline/inlineChat2Prompt';
import { ToolName } from '../../tools/common/toolNames';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { CopilotToolMode } from '../../tools/common/toolsRegistry';
import { isToolValidationError, isValidatedToolInput, IToolsService } from '../../tools/common/toolsService';
import { InteractionOutcomeComputer } from './promptCraftingTypes';


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
	) { }

	async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, _location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {

		assertType(request.location2 instanceof ChatRequestEditorData);

		if (await this._ignoreService.isCopilotIgnored(request.location2.document.uri, token)) {
			return {
				errorDetails: {
					message: localize('inlineChat.ignored', "Copilot is disabled for this file."),
				}
			};
		}

		const endpoint = await this._endpointProvider.getChatEndpoint(request);

		if (!endpoint.supportsToolCalls) {
			return {
				errorDetails: {
					message: localize('inlineChat.model', "{0} cannot be used for inline chat", endpoint.name),
				}
			};
		}

		const inlineChatTools = await this._getAvailableTools(request);

		const chatVariables = new ChatVariablesCollection([...request.references]);

		const renderer = PromptRenderer.create(this._instantiationService, endpoint, InlineChat2Prompt, {
			request,
			data: request.location2,
			exitToolName: INLINE_CHAT_EXIT_TOOL_NAME
		});

		const renderResult = await renderer.render(undefined, token, { trace: true });

		const telemetry = chatTelemetry.makeRequest(this, ChatLocation.Editor, conversation, renderResult.messages, renderResult.tokenCount, renderResult.references, endpoint, [], inlineChatTools.length);
		const outcomeComputer = new InteractionOutcomeComputer(request.location2.document.uri);

		stream = outcomeComputer.spyOnStream(stream);
		const toolCalls: IToolCall[] = [];
		let toolError: unknown | undefined;

		const fetchResult = await endpoint.makeChatRequest2({
			debugName: 'InlineChat2Intent',
			messages: renderResult.messages,
			userInitiatedRequest: true,
			location: ChatLocation.Editor,
			finishedCb: async (_text, _index, delta) => {

				let doneAfterToolCalls = false;

				if (isNonEmptyArray(delta.copilotToolCalls)) {
					for (const toolCall of delta.copilotToolCalls) {

						toolCalls.push(toolCall);

						doneAfterToolCalls = doneAfterToolCalls
							|| InlineChatIntent._EDIT_TOOLS.has(toolCall.name)
							|| toolCall.name === INLINE_CHAT_EXIT_TOOL_NAME;

						const validationResult = this._toolsService.validateToolInput(toolCall.name, toolCall.arguments);

						if (isToolValidationError(validationResult)) {
							this._logService.warn(`Tool ${toolCall.name} invocation failed validation: ${validationResult}`);
							break;
						}

						try {
							let input = isValidatedToolInput(validationResult)
								? validationResult.inputObj
								: JSON.parse(toolCall.arguments);

							const copilotTool = this._toolsService.getCopilotTool(toolCall.name as ToolName);
							if (copilotTool?.resolveInput) {
								input = await copilotTool.resolveInput(input, {
									request,
									stream,
									query: request.prompt,
									chatVariables,
									history: [],
								}, CopilotToolMode.FullContext);
							}

							const result = await this._toolsService.invokeTool(toolCall.name, {
								input,
								toolInvocationToken: request.toolInvocationToken,
							}, token);

							this._logService.trace(`Tool ${toolCall.name} invocation result: ${JSON.stringify(result)}`);

						} catch (err) {
							this._logService.error(err, `Tool ${toolCall.name} invocation failed`);
							toolError = err;
						}
					}
				}

				if (doneAfterToolCalls) {
					return 1; // stop generating further
				}

				return undefined;
			},
			requestOptions: {
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
			}
		}, token);

		// telemetry
		{
			const responseText = fetchResult.type === ChatFetchResponseType.Success ? fetchResult.value : '';
			const toolCallRound = ToolCallRound.create({
				response: responseText,
				toolCalls: toolCalls,
				toolInputRetry: 0
			});

			telemetry.sendToolCallingTelemetry([toolCallRound], inlineChatTools, fetchResult.type);

			telemetry.sendTelemetry(
				fetchResult.requestId, fetchResult.type, responseText,
				outcomeComputer.interactionOutcome,
				toolCalls
			);
		}

		if (fetchResult.type !== ChatFetchResponseType.Success) {
			const details = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
			return {
				errorDetails: {
					message: details.message,
					responseIsFiltered: details.responseIsFiltered
				}
			};
		}

		if (toolError) {
			return {
				errorDetails: {
					message: toErrorMessage(toolError)
				}
			};
		}

		if (toolCalls.length === 0) {
			// when no tools were called, invoke the exit tool manually
			await this._toolsService.invokeTool(INLINE_CHAT_EXIT_TOOL_NAME, { toolInvocationToken: request.toolInvocationToken, input: undefined }, token);
		}

		return {};

	}

	private async _getAvailableTools(request: vscode.ChatRequest): Promise<vscode.LanguageModelToolInformation[]> {

		const exitTool = this._toolsService.getTool(INLINE_CHAT_EXIT_TOOL_NAME);
		assertType(exitTool);

		const agentTools = await getAgentTools(this._instantiationService, request);
		const editTools = agentTools.filter(tool => InlineChatIntent._EDIT_TOOLS.has(tool.name));

		return [exitTool, ...editTools];
	}

	invoke(): Promise<never> {
		throw new TypeError();
	}
}
