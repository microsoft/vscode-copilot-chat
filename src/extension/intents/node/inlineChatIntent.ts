/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { modelSupportsMultiReplaceString, modelSupportsReplaceString } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { assertType } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditorData, Location } from '../../../vscodeTypes';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext, InternalToolReference } from '../../prompt/common/intents';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IBuildPromptResult, IIntent } from '../../prompt/node/intents';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { getToolName, ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { EditCodeIntent, EditCodeIntentOptions } from './editCodeIntent';
import { EditCode2IntentInvocation } from './editCodeIntent2';
import { getRequestedToolCallIterationLimit } from './toolCallingLoop';


function getInlineChatTools(instaService: IInstantiationService, request: vscode.ChatRequest): Promise<vscode.LanguageModelToolInformation[]> {
	return instaService.invokeFunction(async accessor => {
		const toolsService = accessor.get<IToolsService>(IToolsService);
		const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
		// const notebookService = accessor.get<INotebookService>(INotebookService);
		const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
		const experimentationService = accessor.get<IExperimentationService>(IExperimentationService);
		const model = await endpointProvider.getChatEndpoint(request);
		const lookForTools = new Set<string>([ToolName.EditFile]);

		// if (requestHasNotebookRefs(request, notebookService, { checkPromptAsWell: true })) {
		// 	lookForTools.add(ToolName.CreateNewJupyterNotebook);
		// }

		if (await modelSupportsReplaceString(model)) {
			lookForTools.add(ToolName.ReplaceString);
			if (await modelSupportsMultiReplaceString(model) && configurationService.getExperimentBasedConfig(ConfigKey.Internal.MultiReplaceString, experimentationService)) {
				lookForTools.add(ToolName.MultiReplaceString);
			}
		}

		// lookForTools.add(ToolName.EditNotebook);
		// lookForTools.add(ToolName.GetNotebookSummary);
		// lookForTools.add(ToolName.RunNotebookCell);
		// lookForTools.add(ToolName.ReadCellOutput);

		return toolsService.getEnabledTools(request, tool => lookForTools.has(tool.name) || tool.tags.includes('notebooks'));
	});
}

export class InlineChatIntent extends EditCodeIntent {

	static override readonly ID = Intent.InlineChat;

	override readonly id = InlineChatIntent.ID;

	override readonly locations = [ChatLocation.Editor];

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { processCodeblocks: false, intentInvocation: InlineChatIntentInvocation });
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ?? this.configurationService.getNonExtensionConfig('chat.agent.maxRequests') ?? 15,
			temperature: this.configurationService.getConfig(ConfigKey.Internal.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Editor,
		};
	}
}

class InlineChatIntentInvocation extends EditCode2IntentInvocation {

	constructor(
		intent: IIntent,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		request: vscode.ChatRequest,
		intentOptions: EditCodeIntentOptions,
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
		@ILogService logService: ILogService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService, logService);
	}

	public override async getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return getInlineChatTools(this.instantiationService, this.request);
	}

	public override buildPrompt(promptContext: IBuildPromptContext, progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>, token: vscode.CancellationToken): Promise<IBuildPromptResult> {

		assertType(this.request.location2 instanceof ChatRequestEditorData);

		const { document, selection } = this.request.location2;

		const inlineChatEditorReference: vscode.ChatPromptReference = {
			id: document.uri.toString(),
			value: selection.isEmpty ? document.uri : new Location(document.uri, selection),
			name: 'Inline Chat Editor'
		};

		const { query, commandToolReferences } = this.processSlashCommand(promptContext.query);

		return super.buildPrompt({
			...promptContext,
			chatVariables: new ChatVariablesCollection([...this.request.references, inlineChatEditorReference]),
			query,
			tools: promptContext.tools && {
				...promptContext.tools,
				toolReferences: this.stableToolReferences.filter((r) => r.name !== ToolName.Codebase).concat(commandToolReferences),
			},
		}, progress, token);
	}

	// TODO@jrieken does this make sense?
	private processSlashCommand(query: string): { query: string; commandToolReferences: InternalToolReference[] } {
		const commandToolReferences: InternalToolReference[] = [];
		const command = this.request.command && this.commandService.getCommand(this.request.command, this.location);
		if (command) {
			if (command.toolEquivalent) {
				commandToolReferences.push({
					id: `${this.request.command}->${generateUuid()}`,
					name: getToolName(command.toolEquivalent)
				});
			}
			query = query ? `${command.details}.\n${query}` : command.details;
		}

		return { query, commandToolReferences };
	}
}
