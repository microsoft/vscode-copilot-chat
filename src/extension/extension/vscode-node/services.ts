/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, ExtensionMode } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { getOrCreateTestingCopilotTokenManager } from '../../../platform/authentication/node/copilotTokenManager';
import { AuthenticationService } from '../../../platform/authentication/vscode-node/authenticationService';
import { VSCodeCopilotTokenManager } from '../../../platform/authentication/vscode-node/copilotTokenManager';
import { IChatAgentService } from '../../../platform/chat/common/chatAgents';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IChunkingEndpointClient } from '../../../platform/chunking/common/chunkingEndpointClient';
import { ChunkingEndpointClientImpl } from '../../../platform/chunking/common/chunkingEndpointClientImpl';
import { INaiveChunkingService, NaiveChunkingService } from '../../../platform/chunking/node/naiveChunkerService';
import { IDevContainerConfigurationService } from '../../../platform/devcontainer/common/devContainerConfigurationService';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { DiffServiceImpl } from '../../../platform/diff/node/diffServiceImpl';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CAPIClientImpl } from '../../../platform/endpoint/node/capiClientImpl';
import { DomainService } from '../../../platform/endpoint/node/domainServiceImpl';
import { IGitCommitMessageService } from '../../../platform/git/common/gitCommitMessageService';
import { IGitDiffService } from '../../../platform/git/common/gitDiffService';
import { IGithubRepositoryService } from '../../../platform/github/common/githubService';
import { GithubRepositoryService } from '../../../platform/github/node/githubRepositoryService';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { VsCodeIgnoreService } from '../../../platform/ignore/vscode-node/ignoreService';
import { ILanguageContextService } from '../../../platform/languageServer/common/languageContextService';
import { ICompletionsFetchService } from '../../../platform/nesFetch/common/completionsFetchService';
import { CompletionsFetchService } from '../../../platform/nesFetch/node/completionsFetchServiceImpl';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { FetcherService } from '../../../platform/networking/vscode-node/fetcherServiceImpl';
import { IParserService } from '../../../platform/parser/node/parserService';
import { ParserServiceImpl } from '../../../platform/parser/node/parserServiceImpl';
import { AdoCodeSearchService, IAdoCodeSearchService } from '../../../platform/remoteCodeSearch/common/adoCodeSearchService';
import { GithubCodeSearchService, IGithubCodeSearchService } from '../../../platform/remoteCodeSearch/common/githubCodeSearchService';
import { ICodeSearchAuthenticationService } from '../../../platform/remoteCodeSearch/node/codeSearchRepoAuth';
import { VsCodeCodeSearchAuthenticationService } from '../../../platform/remoteCodeSearch/vscode-node/codeSearchRepoAuth';
import { IDocsSearchClient } from '../../../platform/remoteSearch/common/codeOrDocsSearchClient';
import { DocsSearchClient } from '../../../platform/remoteSearch/node/codeOrDocsSearchClientImpl';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IScopeSelector } from '../../../platform/scopeSelection/common/scopeSelection';
import { ScopeSelectorImpl } from '../../../platform/scopeSelection/vscode-node/scopeSelectionImpl';
import { ISearchService } from '../../../platform/search/common/searchService';
import { SearchServiceImpl } from '../../../platform/search/vscode-node/searchServiceImpl';
import { ISettingsEditorSearchService } from '../../../platform/settingsEditor/common/settingsEditorSearchService';
import { IExperimentationService, NullExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { NullTelemetryService } from '../../../platform/telemetry/common/nullTelemetryService';
import { ITelemetryService, ITelemetryUserConfig, TelemetryUserConfigImpl } from '../../../platform/telemetry/common/telemetry';
import { APP_INSIGHTS_KEY_ENHANCED, APP_INSIGHTS_KEY_STANDARD } from '../../../platform/telemetry/node/azureInsights';
import { MicrosoftExperimentationService } from '../../../platform/telemetry/vscode-node/microsoftExperimentationService';
import { TelemetryService } from '../../../platform/telemetry/vscode-node/telemetryServiceImpl';
import { IWorkspaceMutationManager } from '../../../platform/testing/common/workspaceMutationManager';
import { ISetupTestsDetector, SetupTestsDetector } from '../../../platform/testing/node/setupTestDetector';
import { ITestDepsResolver, TestDepsResolver } from '../../../platform/testing/node/testDepsResolver';
import { IThinkingDataService, ThinkingDataImpl } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider, TokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IWorkspaceChunkSearchService, WorkspaceChunkSearchService } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { IWorkspaceFileIndex, WorkspaceFileIndex } from '../../../platform/workspaceChunkSearch/node/workspaceFileIndex';
import { IInstantiationServiceBuilder } from '../../../util/common/services';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { CommandServiceImpl, ICommandService } from '../../commands/node/commandService';
import { ApiEmbeddingsIndex, IApiEmbeddingsIndex } from '../../context/node/resolvers/extensionApi';
import { IPromptWorkspaceLabels, PromptWorkspaceLabels } from '../../context/node/resolvers/promptWorkspaceLabels';
import { ChatAgentService } from '../../conversation/vscode-node/chatParticipants';
import { FeedbackReporter } from '../../conversation/vscode-node/feedbackReporter';
import { IUserFeedbackService, UserFeedbackService } from '../../conversation/vscode-node/userActions';
import { ConversationStore, IConversationStore } from '../../conversationStore/node/conversationStore';
import { IIntentService, IntentService } from '../../intents/node/intentService';
import { INewWorkspacePreviewContentManager, NewWorkspacePreviewContentManagerImpl } from '../../intents/node/newIntent';
import { ITestGenInfoStorage, TestGenInfoStorage } from '../../intents/node/testIntent/testInfoStorage';
import { LanguageContextProviderService } from '../../languageContextProvider/vscode-node/languageContextProviderService';
import { ILinkifyService, LinkifyService } from '../../linkify/common/linkifyService';
import { collectFetcherTelemetry } from '../../log/vscode-node/loggingActions';
import { DebugCommandToConfigConverter, IDebugCommandToConfigConverter } from '../../onboardDebug/node/commandToConfigConverter';
import { DebuggableCommandIdentifier, IDebuggableCommandIdentifier } from '../../onboardDebug/node/debuggableCommandIdentifier';
import { ILanguageToolsProvider, LanguageToolsProvider } from '../../onboardDebug/node/languageToolsProvider';
import { ChatMLFetcherImpl } from '../../prompt/node/chatMLFetcher';
import { IFeedbackReporter } from '../../prompt/node/feedbackReporter';
import { IPromptVariablesService } from '../../prompt/node/promptVariablesService';
import { DevContainerConfigurationServiceImpl } from '../../prompt/vscode-node/devContainerConfigurationServiceImpl';
import { ProductionEndpointProvider } from '../../prompt/vscode-node/endpointProviderImpl';
import { GitCommitMessageServiceImpl } from '../../prompt/vscode-node/gitCommitMessageServiceImpl';
import { GitDiffService } from '../../prompt/vscode-node/gitDiffService';
import { PromptVariablesServiceImpl } from '../../prompt/vscode-node/promptVariablesService';
import { RequestLogger } from '../../prompt/vscode-node/requestLoggerImpl';
import { SettingsEditorSearchServiceImpl } from '../../prompt/vscode-node/settingsEditorSearchServiceImpl';
import { CodeMapperService, ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { FixCookbookService, IFixCookbookService } from '../../prompts/node/inline/fixCookbookService';
import { WorkspaceMutationManager } from '../../testing/node/setupTestsFileManager';
import { IToolsService } from '../../tools/common/toolsService';
import { ToolsService } from '../../tools/vscode-node/toolsService';
import { LanguageContextServiceImpl } from '../../typescriptContext/vscode-node/languageContextService';
import { IWorkspaceListenerService } from '../../workspaceRecorder/common/workspaceListenerService';
import { WorkspacListenerService } from '../../workspaceRecorder/vscode-node/workspaceListenerService';
import { registerServices as registerCommonServices } from '../vscode/services';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';

// ###########################################################################################
// ###                                                                                     ###
// ###               Node services that run ONLY in node.js extension host.                ###
// ###                                                                                     ###
// ###  !!! Prefer to list services in ../vscode/services.ts to support them anywhere !!!  ###
// ###                                                                                     ###
// ###########################################################################################

export function registerServices(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext): void {
	const isTestMode = extensionContext.extensionMode === ExtensionMode.Test;

	registerCommonServices(builder, extensionContext);

	builder.define(IConversationStore, new ConversationStore());
	builder.define(IDiffService, new DiffServiceImpl());
	builder.define(ITokenizerProvider, new SyncDescriptor(TokenizerProvider, [true]));
	builder.define(IToolsService, new SyncDescriptor(ToolsService));
	builder.define(IRequestLogger, new SyncDescriptor(RequestLogger));

	builder.define(IFetcherService, new SyncDescriptor(FetcherService, [undefined]));
	builder.define(IDomainService, new SyncDescriptor(DomainService));
	builder.define(ICAPIClientService, new SyncDescriptor(CAPIClientImpl));

	builder.define(ITelemetryUserConfig, new SyncDescriptor(TelemetryUserConfigImpl, [undefined, undefined]));
	const internalAIKey = extensionContext.extension.packageJSON.internalAIKey ?? '';
	const internalLargeEventAIKey = extensionContext.extension.packageJSON.internalLargeStorageAriaKey ?? '';
	const ariaKey = extensionContext.extension.packageJSON.ariaKey ?? '';
	if (isTestMode) {
		setupTelemetry(builder, extensionContext, internalAIKey, internalLargeEventAIKey, ariaKey);
		// If we're in testing mode, then most code will be called from an actual test,
		// and not from here. However, some objects will capture the `accessor` we pass
		// here and then re-use it later. This is particularly the case for those objects
		// which implement VSCode interfaces so can't be changed to take `accessor` in their
		// method parameters.
		builder.define(ICopilotTokenManager, getOrCreateTestingCopilotTokenManager());
	} else {
		setupTelemetry(builder, extensionContext, internalAIKey, internalLargeEventAIKey, ariaKey);
		builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
	}
	builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));

	builder.define(ITestGenInfoStorage, new SyncDescriptor(TestGenInfoStorage)); // Used for test generation (/tests intent)
	builder.define(IEndpointProvider, new SyncDescriptor(ProductionEndpointProvider, [collectFetcherTelemetry]));
	builder.define(IParserService, new SyncDescriptor(ParserServiceImpl, [/*useWorker*/ true]));
	builder.define(IIntentService, new SyncDescriptor(IntentService));
	builder.define(IIgnoreService, new SyncDescriptor(VsCodeIgnoreService));
	builder.define(INaiveChunkingService, new SyncDescriptor(NaiveChunkingService));
	builder.define(IWorkspaceFileIndex, new SyncDescriptor(WorkspaceFileIndex));
	builder.define(IChunkingEndpointClient, new SyncDescriptor(ChunkingEndpointClientImpl));
	builder.define(ICommandService, new SyncDescriptor(CommandServiceImpl));
	builder.define(IDocsSearchClient, new SyncDescriptor(DocsSearchClient));
	builder.define(ISearchService, new SyncDescriptor(SearchServiceImpl));
	builder.define(ITestDepsResolver, new SyncDescriptor(TestDepsResolver));
	builder.define(ISetupTestsDetector, new SyncDescriptor(SetupTestsDetector));
	builder.define(IWorkspaceMutationManager, new SyncDescriptor(WorkspaceMutationManager));
	builder.define(IScopeSelector, new SyncDescriptor(ScopeSelectorImpl));
	builder.define(IGitDiffService, new SyncDescriptor(GitDiffService));
	builder.define(IGitCommitMessageService, new SyncDescriptor(GitCommitMessageServiceImpl));
	builder.define(IGithubRepositoryService, new SyncDescriptor(GithubRepositoryService));
	builder.define(IDevContainerConfigurationService, new SyncDescriptor(DevContainerConfigurationServiceImpl));
	builder.define(IChatAgentService, new SyncDescriptor(ChatAgentService));
	builder.define(ILinkifyService, new SyncDescriptor(LinkifyService));
	builder.define(IChatMLFetcher, new SyncDescriptor(ChatMLFetcherImpl));
	builder.define(IFeedbackReporter, new SyncDescriptor(FeedbackReporter));
	builder.define(IApiEmbeddingsIndex, new SyncDescriptor(ApiEmbeddingsIndex, [/*useRemoteCache*/ true]));
	builder.define(IGithubCodeSearchService, new SyncDescriptor(GithubCodeSearchService));
	builder.define(IAdoCodeSearchService, new SyncDescriptor(AdoCodeSearchService));
	builder.define(IWorkspaceChunkSearchService, new SyncDescriptor(WorkspaceChunkSearchService));
	builder.define(ISettingsEditorSearchService, new SyncDescriptor(SettingsEditorSearchServiceImpl));
	builder.define(INewWorkspacePreviewContentManager, new SyncDescriptor(NewWorkspacePreviewContentManagerImpl));
	builder.define(IPromptVariablesService, new SyncDescriptor(PromptVariablesServiceImpl));
	builder.define(IPromptWorkspaceLabels, new SyncDescriptor(PromptWorkspaceLabels));
	builder.define(IUserFeedbackService, new SyncDescriptor(UserFeedbackService));
	builder.define(IDebugCommandToConfigConverter, new SyncDescriptor(DebugCommandToConfigConverter));
	builder.define(IDebuggableCommandIdentifier, new SyncDescriptor(DebuggableCommandIdentifier));
	builder.define(ILanguageToolsProvider, new SyncDescriptor(LanguageToolsProvider));
	builder.define(ICodeMapperService, new SyncDescriptor(CodeMapperService));
	builder.define(ICompletionsFetchService, new SyncDescriptor(CompletionsFetchService));
	builder.define(IFixCookbookService, new SyncDescriptor(FixCookbookService));
	builder.define(ILanguageContextService, new SyncDescriptor(LanguageContextServiceImpl));
	builder.define(ILanguageContextProviderService, new SyncDescriptor(LanguageContextProviderService));
	builder.define(IWorkspaceListenerService, new SyncDescriptor(WorkspacListenerService));
	builder.define(ICodeSearchAuthenticationService, new SyncDescriptor(VsCodeCodeSearchAuthenticationService));
	builder.define(IThinkingDataService, new SyncDescriptor(ThinkingDataImpl));
}

function setupMSFTExperimentationService(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext) {
	if (ExtensionMode.Production === extensionContext.extensionMode) {
		// Intitiate the experimentation service
		builder.define(IExperimentationService, new SyncDescriptor(MicrosoftExperimentationService));
	} else {
		builder.define(IExperimentationService, new NullExperimentationService());
	}
}

function setupTelemetry(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext, internalAIKey: string, internalLargeEventAIKey: string, externalAIKey: string) {

	if (ExtensionMode.Production === extensionContext.extensionMode) {
		builder.define(ITelemetryService, new SyncDescriptor(TelemetryService, [
			extensionContext.extension.packageJSON.name,
			internalAIKey,
			internalLargeEventAIKey,
			externalAIKey,
			APP_INSIGHTS_KEY_STANDARD,
			APP_INSIGHTS_KEY_ENHANCED,
		]));
	} else {
		// If we're developing or testing we don't want telemetry to be sent, so we turn it off
		builder.define(ITelemetryService, new NullTelemetryService());
	}

	setupMSFTExperimentationService(builder, extensionContext);
}
