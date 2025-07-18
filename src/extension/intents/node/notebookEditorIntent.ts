/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { NotebookDocumentSnapshot } from '../../../platform/editing/common/notebookDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { getAltNotebookRange, IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { requestHasNotebookRefs } from '../../../platform/notebook/common/helpers';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Range } from '../../../vscodeTypes';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { IBuildPromptContext, IWorkingSet, IWorkingSetEntry, WorkingSetEntryState } from '../../prompt/common/intents';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IBuildPromptResult, IIntent, IntentLinkificationOptions } from '../../prompt/node/intents';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { EditCodeIntent, EditCodeIntentOptions } from './editCodeIntent';
import { EditCode2IntentInvocation } from './editCodeIntent2';
import { getRequestedToolCallIterationLimit } from './toolCallingLoop';

const getTools = (instaService: IInstantiationService, request: vscode.ChatRequest): Promise<vscode.LanguageModelToolInformation[]> =>
	instaService.invokeFunction(async accessor => {
		const toolsService = accessor.get<IToolsService>(IToolsService);
		const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
		const notebookService = accessor.get<INotebookService>(INotebookService);
		const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
		const experimentalService = accessor.get<IExperimentationService>(IExperimentationService);
		const model = await endpointProvider.getChatEndpoint(request);
		const lookForTools = new Set<string>([ToolName.EditFile]);

		if (configurationService.getExperimentBasedConfig(ConfigKey.EditsCodeNewNotebookAgentEnabled, experimentalService) !== false && requestHasNotebookRefs(request, notebookService, { checkPromptAsWell: true })) {
			lookForTools.add(ToolName.CreateNewJupyterNotebook);
		}

		if (model.family.startsWith('claude')) {
			lookForTools.add(ToolName.ReplaceString);
		}

		lookForTools.add(ToolName.EditNotebook);
		lookForTools.add(ToolName.GetNotebookSummary);
		lookForTools.add(ToolName.RunNotebookCell);
		lookForTools.add(ToolName.ReadCellOutput);

		return toolsService.getEnabledTools(request, tool => lookForTools.has(tool.name));
	});

export class NotebookEditorIntent extends EditCodeIntent {

	static override readonly ID = Intent.notebookEditor;

	override readonly id = NotebookEditorIntent.ID;

	override readonly locations = [ChatLocation.Notebook];

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { processCodeblocks: false, intentInvocation: NotebookEditorIntentInvocation });
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ?? this.configurationService.getNonExtensionConfig('chat.agent.maxRequests') ?? 15,
			temperature: this.configurationService.getConfig(ConfigKey.Internal.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Notebook,  // unsure if this should be set
		};
	}
}

export class NotebookEditorIntentInvocation extends EditCode2IntentInvocation {

	public override get linkification(): IntentLinkificationOptions {
		// off by default:
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.EditLinkification) === true;
		return { disable: !enabled };
	}

	constructor(
		intent: IIntent,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		request: vscode.ChatRequest,
		intentOptions: EditCodeIntentOptions,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContentService: IAlternativeNotebookContentService,
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
		@IExperimentationService experimentationService: IExperimentationService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService, logService, experimentationService);
	}

	public override async getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return getTools(this.instantiationService, this.request);
	}

	public override buildPrompt(promptContext: IBuildPromptContext, progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>, token: vscode.CancellationToken): Promise<IBuildPromptResult> {
		const editor = this.tabsAndEditorsService.activeNotebookEditor;
		let workingSet: IWorkingSet | undefined = undefined;
		if (editor) {
			const format = this.alternativeNotebookContentService.getFormat(this.endpoint);
			const documentSnapshot = NotebookDocumentSnapshot.create(editor.notebook, format);

			const cell = editor.notebook.cellAt(editor.selection.start);
			const cellRange = new Range(cell.document.lineAt(0).range.start, cell.document.lineAt(cell.document.lineCount - 1).range.end);
			const range = getAltNotebookRange(cellRange, cell.document.uri, editor.notebook, format);

			const entry: IWorkingSetEntry = {
				document: documentSnapshot,
				isMarkedReadonly: false,
				state: WorkingSetEntryState.Initial,
				range
			};
			workingSet = [entry];
		}

		return super.buildPrompt({ ...promptContext, workingSet }, progress, token);
	}
}
