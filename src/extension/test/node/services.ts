/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolGroupingCache } from '../../../extension/tools/common/virtualTools/virtualToolGroupCache';
import { IToolGroupingCache, IToolGroupingService } from '../../../extension/tools/common/virtualTools/virtualToolTypes';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { MockChatMLFetcher } from '../../../platform/chat/test/common/mockChatMLFetcher';
import { EMBEDDING_MODEL } from '../../../platform/configuration/common/configurationService';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { DiffServiceImpl } from '../../../platform/diff/node/diffServiceImpl';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IModelConfig } from '../../../platform/endpoint/test/node/openaiCompatibleEndpoint';
import { TestEndpointProvider } from '../../../platform/endpoint/test/node/testEndpointProvider';
import { EditLogService, IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { IMultiFileEditInternalTelemetryService, MultiFileEditInternalTelemetryService } from '../../../platform/multiFileEdit/common/multiFileEditQualityTelemetry';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { AlternativeNotebookContentEditGenerator, IAlternativeNotebookContentEditGenerator } from '../../../platform/notebook/common/alternativeContentEditGenerator';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { INotebookSummaryTracker } from '../../../platform/notebook/common/notebookSummaryTracker';
import { AdoCodeSearchService, IAdoCodeSearchService } from '../../../platform/remoteCodeSearch/common/adoCodeSearchService';
import { GithubCodeSearchService, IGithubCodeSearchService } from '../../../platform/remoteCodeSearch/common/githubCodeSearchService';
import { ISimulationTestContext, NulSimulationTestContext } from '../../../platform/simulationTestContext/common/simulationTestContext';
import { ITerminalService, NullTerminalService } from '../../../platform/terminal/common/terminalService';
import { TestingServiceCollection, createPlatformServices } from '../../../platform/test/node/services';
import { SimulationAlternativeNotebookContentService, SimulationNotebookService, SimulationNotebookSummaryTracker } from '../../../platform/test/node/simulationWorkspaceServices';
import { NullTestProvider } from '../../../platform/testing/common/nullTestProvider';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { IWorkspaceChunkSearchService, NullWorkspaceChunkSearchService } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { CommandServiceImpl, ICommandService } from '../../commands/node/commandService';
import { ILinkifyService, LinkifyService } from '../../linkify/common/linkifyService';
import { IFeedbackReporter, NullFeedbackReporterImpl } from '../../prompt/node/feedbackReporter';
import { IPromptVariablesService, NullPromptVariablesService } from '../../prompt/node/promptVariablesService';
import { CodeMapperService, ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { FixCookbookService, IFixCookbookService } from '../../prompts/node/inline/fixCookbookService';
import { IToolsService } from '../../tools/common/toolsService';
import { ToolGroupingService } from '../../tools/common/virtualTools/toolGroupingService';
import '../../tools/node/allTools';
import { TestToolsService } from '../../tools/node/test/testToolsService';

export interface ISimulationModelConfig {
	chatModel?: string;
	smartChatModel?: string;
	fastChatModel?: string;
	embeddingModel?: EMBEDDING_MODEL;
	fastRewriteModel?: string;
	skipModelMetadataCache?: boolean;
	customModelConfigs?: Map<string, IModelConfig>;
}

export function createExtensionUnitTestingServices(currentTestRunInfo?: any, modelConfig?: ISimulationModelConfig): TestingServiceCollection {
	const testingServiceCollection = createPlatformServices();
	testingServiceCollection.define(
		IEndpointProvider,
		new SyncDescriptor(TestEndpointProvider, [
			modelConfig?.smartChatModel ?? modelConfig?.chatModel,
			modelConfig?.fastChatModel ?? modelConfig?.chatModel,
			modelConfig?.embeddingModel,
			modelConfig?.fastRewriteModel,
			currentTestRunInfo,
			!!modelConfig?.skipModelMetadataCache,
			modelConfig?.customModelConfigs,
		])
	);
	testingServiceCollection.define(IGithubCodeSearchService, new SyncDescriptor(GithubCodeSearchService));
	testingServiceCollection.define(ITestProvider, new NullTestProvider());
	testingServiceCollection.define(IAdoCodeSearchService, new SyncDescriptor(AdoCodeSearchService));
	testingServiceCollection.define(IWorkspaceChunkSearchService, new SyncDescriptor(NullWorkspaceChunkSearchService));
	testingServiceCollection.define(IPromptVariablesService, new SyncDescriptor(NullPromptVariablesService));
	testingServiceCollection.define(ILinkifyService, new SyncDescriptor(LinkifyService));
	testingServiceCollection.define(ICommandService, new SyncDescriptor(CommandServiceImpl));
	testingServiceCollection.define(IFeedbackReporter, new SyncDescriptor(NullFeedbackReporterImpl));
	testingServiceCollection.define(IChatMLFetcher, new SyncDescriptor(MockChatMLFetcher));
	testingServiceCollection.define(IToolsService, new SyncDescriptor(TestToolsService, [new Set()]));
	testingServiceCollection.define(IEditLogService, new SyncDescriptor(EditLogService));
	testingServiceCollection.define(IMultiFileEditInternalTelemetryService, new SyncDescriptor(MultiFileEditInternalTelemetryService));
	testingServiceCollection.define(ICodeMapperService, new SyncDescriptor(CodeMapperService));
	testingServiceCollection.define(IAlternativeNotebookContentService, new SyncDescriptor(SimulationAlternativeNotebookContentService));
	testingServiceCollection.define(IAlternativeNotebookContentEditGenerator, new SyncDescriptor(AlternativeNotebookContentEditGenerator));
	testingServiceCollection.define(IDiffService, new SyncDescriptor(DiffServiceImpl));
	testingServiceCollection.define(IFixCookbookService, new SyncDescriptor(FixCookbookService));
	testingServiceCollection.define(ISimulationTestContext, new SyncDescriptor(NulSimulationTestContext));
	testingServiceCollection.define(INotebookService, new SyncDescriptor(SimulationNotebookService));
	testingServiceCollection.define(INotebookSummaryTracker, new SyncDescriptor(SimulationNotebookSummaryTracker));
	testingServiceCollection.define(ITerminalService, new SyncDescriptor(NullTerminalService));
	testingServiceCollection.define(IToolGroupingCache, new SyncDescriptor(ToolGroupingCache));
	testingServiceCollection.define(IToolGroupingService, new SyncDescriptor(ToolGroupingService));
	return testingServiceCollection;
}
