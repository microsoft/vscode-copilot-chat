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
import { Event } from '../../../util/vs/base/common/event';
import { assertType } from '../../../util/vs/base/common/types';
import { localize } from '../../../util/vs/nls';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditorData } from '../../../vscodeTypes';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent } from '../../prompt/node/intents';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { InlineChat2Prompt } from '../../prompts/node/inline/inlineChat2Prompt';
import { ToolName } from '../../tools/common/toolNames';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { CopilotToolMode } from '../../tools/common/toolsRegistry';
import { isToolValidationError, isValidatedToolInput, IToolsService } from '../../tools/common/toolsService';
import { getAgentTools } from './agentIntent';


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

	async handleRequest(_conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {

		assertType(request.location2 instanceof ChatRequestEditorData);


		if (await this._ignoreService.isCopilotIgnored(request.location2.document.uri, token)) {
			return {
				errorDetails: {
					message: localize('inlineChat.ignored', "Copilot is disabled for this file."),
				}
			};
		}

		const endpoint = await this._endpointProvider.getChatEndpoint(request);

		const inlineChatTools = await this.getAvailableTools(request);

		const chatVariables = new ChatVariablesCollection([...request.references]);

		const renderer = PromptRenderer.create(this._instantiationService, endpoint, InlineChat2Prompt, {
			request,
			data: request.location2
		});

		const renderResult = await renderer.render(undefined, token, { trace: true });

		const fetchResult = await endpoint.makeChatRequest2({
			debugName: 'InlineChatIntent',
			messages: renderResult.messages,
			location: ChatLocation.Editor,
			finishedCb: async (_text, _index, delta) => {

				let didSeeEditTool = false;

				if (isNonEmptyArray(delta.copilotToolCalls)) {
					for (const toolCall of delta.copilotToolCalls) {

						didSeeEditTool = didSeeEditTool || InlineChatIntent._EDIT_TOOLS.has(toolCall.name);

						const validationResult = this._toolsService.validateToolInput(toolCall.name, toolCall.arguments);

						if (isToolValidationError(validationResult)) {
							console.log(validationResult);
							break;
						}

						const input = isValidatedToolInput(validationResult)
							? validationResult.inputObj
							: JSON.parse(toolCall.arguments);

						const copilotTool = this._toolsService.getCopilotTool(toolCall.name as ToolName);
						if (copilotTool?.resolveInput) {
							copilotTool.resolveInput(input, {
								request,
								stream,
								query: request.prompt,
								chatVariables,
								history: [],
							}, CopilotToolMode.FullContext);
						}

						await this._toolsService.invokeTool(toolCall.name, {
							input,
							toolInvocationToken: request.toolInvocationToken,
						}, token);
					}
				}

				if (didSeeEditTool) {
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

		if (fetchResult.type !== ChatFetchResponseType.Success) {
			const details = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
			return {
				errorDetails: {
					message: details.message,
					responseIsFiltered: details.responseIsFiltered
				}
			};
		}

		return {};

	}

	invoke(): Promise<never> {
		throw new Error('Method not implemented.');
	}

	private async getAvailableTools(request: vscode.ChatRequest): Promise<vscode.LanguageModelToolInformation[]> {

		const inlineChatToolFilter = new Set<string>([
			// -- editing
			...InlineChatIntent._EDIT_TOOLS,
			// -- getting errors
			// ToolName.GetErrors,
			// -- TODO@jrieken SLASH commands
		]);


		const agentTools = await getAgentTools(this._instantiationService, request);
		const inlineChatTools = agentTools.filter(tool => inlineChatToolFilter.has(tool.name));
		return inlineChatTools;
	}
}

// class InlineChatIntentInvocation extends AgentIntentInvocation {


// 	private _snapshot: TextDocumentSnapshot | undefined;

// 	protected override prompt = InlineChat2Prompt;

// 	public override async getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {

// 		const inlineChatToolFilter = new Set<string>([
// 			// -- editing
// 			ToolName.ApplyPatch,
// 			ToolName.EditFile,
// 			ToolName.ReplaceString,
// 			ToolName.MultiReplaceString,
// 			// -- getting errors
// 			ToolName.GetErrors,
// 			// -- TODO@jrieken SLASH commands
// 		]);


// 		const agentTools = await getAgentTools(this.instantiationService, this.request);
// 		const inlineChatTools = agentTools.filter(tool => inlineChatToolFilter.has(tool.name));
// 		return inlineChatTools;
// 	}

// 	public override async buildPrompt(promptContext: IBuildPromptContext, progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>, token: vscode.CancellationToken): Promise<IBuildPromptResult> {

// 		assertType(this.request.location2 instanceof ChatRequestEditorData);

// 		const { document, selection } = this.request.location2;

// 		// TODO@jrieken FISHY but helps with repeated rendering, esp after making the edit
// 		// and therefore ruining the selection etc...
// 		this._snapshot ??= TextDocumentSnapshot.create(document);

// 		const { query, commandToolReferences } = this.processSlashCommand(promptContext.query);

// 		return super.buildPrompt({
// 			...promptContext,
// 			workingSet: [{ document: this._snapshot, range: selection, state: WorkingSetEntryState.Initial, isMarkedReadonly: undefined }],
// 			chatVariables: new ChatVariablesCollection([...this.request.references]),
// 			query,
// 			tools: promptContext.tools && {
// 				...promptContext.tools,
// 				toolReferences: this.stableToolReferences.filter((r) => r.name !== ToolName.Codebase).concat(commandToolReferences),
// 			},
// 		}, progress, token);
// 	}

// 	// TODO@jrieken does this make sense?
// 	private processSlashCommand(query: string): { query: string; commandToolReferences: InternalToolReference[] } {
// 		const commandToolReferences: InternalToolReference[] = [];
// 		const command = this.request.command && this.commandService.getCommand(this.request.command, this.location);
// 		if (command) {
// 			if (command.toolEquivalent) {
// 				commandToolReferences.push({
// 					id: `${this.request.command}->${generateUuid()}`,
// 					name: getToolName(command.toolEquivalent)
// 				});
// 			}
// 			query = query ? `${command.details}.\n${query}` : command.details;
// 		}

// 		return { query, commandToolReferences };
// 	}
// }
