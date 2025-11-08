/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsEndpointProviderBridge } from '../../../bridge/src/completionsEndpointProviderBridge';
import { CompletionsExperimentationServiceBridge } from '../../../bridge/src/completionsExperimentationServiceBridge';
import { CompletionsIgnoreServiceBridge } from '../../../bridge/src/completionsIgnoreServiceBridge';
import { CompletionsTelemetryServiceBridge, ICompletionsTelemetryService } from '../../../bridge/src/completionsTelemetryServiceBridge';
import { CopilotTokenManager } from '../auth/copilotTokenManager';
import { CitationManager, NoOpCitationManager } from '../citationManager';
import { CompletionNotifier } from '../completionNotifier';
import {
	BuildInfo,
	ConfigProvider,
	DefaultsOnlyConfigProvider,
	EditorAndPluginInfo,
	EditorSession,
	ICompletionsBuildInfoService,
	ICompletionsEditorSessionService,
	InMemoryConfigProvider,
} from '../config';
import { CopilotContentExclusionManager } from '../contentExclusion/contentExclusionManager';
import { Context, ICompletionsContextService } from '../context';
import { UserErrorNotifier } from '../error/userErrorNotifier';
import { Features } from '../experiments/features';
import { FileReader } from '../fileReader';
import { FileSystem } from '../fileSystem';
import { AsyncCompletionManager } from '../ghostText/asyncCompletions';
import { CompletionsCache } from '../ghostText/completionsCache';
import { BlockModeConfig, ConfigBlockModeConfig } from '../ghostText/configBlockMode';
import { CurrentGhostText } from '../ghostText/current';
import { ForceMultiLine } from '../ghostText/ghostText';
import { LastGhostText } from '../ghostText/last';
import { SpeculativeRequestCache } from '../ghostText/speculativeRequestCache';
import { LocalFileSystem } from '../localFileSystem';
import { LogTarget, TelemetryLogSender } from '../logger';
import { TelemetryLogSenderImpl } from '../logging/telemetryLogSender';
import { Fetcher } from '../networking';
import { NotificationSender } from '../notificationSender';
import { AvailableModelsManager } from '../openai/model';
import { NoOpStatusReporter, StatusReporter } from '../progress';
import {
	CompletionsPromptFactory,
	createCompletionsPromptFactory,
} from '../prompt/completionsPromptFactory/completionsPromptFactory';
import { ContextProviderBridge } from '../prompt/components/contextProviderBridge';
import {
	ContextProviderRegistry,
	DefaultContextProviders,
	DefaultContextProvidersContainer,
	getContextProviderRegistry,
} from '../prompt/contextProviderRegistry';
import { ContextProviderStatistics } from '../prompt/contextProviderStatistics';
import { EmptyRecentEditsProvider } from '../prompt/recentEdits/emptyRecentEditsProvider';
import { RecentEditsProvider } from '../prompt/recentEdits/recentEditsProvider';
import { TelemetryReporters, TelemetryUserConfig } from '../telemetry';
import { TextDocumentManager } from '../textDocumentManager';
import { UrlOpener } from '../util/opener';
import { ICompletionsPromiseQueueService, PromiseQueue } from '../util/promiseQueue';
import { ICompletionsRuntimeModeService, RuntimeMode } from '../util/runtimeMode';
import { NoFetchFetcher } from './fetcher';
import { TestNotificationSender, TestUrlOpener } from './testHelpers';
import { TestTextDocumentManager } from './textDocument';

import { ILanguageContextProviderService } from '../../../../../../platform/languageContextProvider/common/languageContextProviderService';
import { NullLanguageContextProviderService } from '../../../../../../platform/languageContextProvider/common/nullLanguageContextProviderService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../../../platform/test/node/services';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionTestingServices } from '../../../../../test/vscode-node/services';
import { CompletionsCapiBridge } from '../../../bridge/src/completionsCapiBridge';
import { FakeCopilotTokenManager } from './copilotTokenManager';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry';

class NullLog extends LogTarget {
	logIt(..._: unknown[]) { }
}

const bridges: any[] = [];
bridges.push(CompletionsEndpointProviderBridge);
bridges.push(CompletionsAuthenticationServiceBridge);
bridges.push(CompletionsIgnoreServiceBridge);
bridges.push(CompletionsExperimentationServiceBridge);
bridges.push(CompletionsCapiBridge);

/**
 * Baseline for a context. Tests should prefer the specific variants outlined below.
 *
 * @see createLibTestingContext
 * @see createExtensionTestingContext
 * @see createAgentTestingContext
 */
export function _createBaselineContext(serviceCollection: TestingServiceCollection, configProvider: InMemoryConfigProvider): ITestingServicesAccessor {
	serviceCollection.set(ILanguageContextProviderService, new NullLanguageContextProviderService());

	const tmpAccessor = serviceCollection.clone().createTestingAccessor();
	const telemetryservice = tmpAccessor.get(ITelemetryService);

	const ctx = new Context();
	serviceCollection.set(ICompletionsContextService, ctx);

	ctx.set(LogTarget, new NullLog());

	const runtimeMode = new RuntimeMode({ debug: false, verboseLogging: false, testMode: true, simulation: false });
	ctx.set(RuntimeMode, runtimeMode);
	serviceCollection.set(ICompletionsRuntimeModeService, runtimeMode);

	const buildInfo = new BuildInfo();
	ctx.set(BuildInfo, buildInfo);
	serviceCollection.set(ICompletionsBuildInfoService, buildInfo);

	const editorSession = new EditorSession('test-session', 'test-machine');
	ctx.set(EditorSession, editorSession);
	serviceCollection.set(ICompletionsEditorSessionService, editorSession);

	const completionsTelemetryService = new CompletionsTelemetryServiceBridge(telemetryservice);
	serviceCollection.set(ICompletionsTelemetryService, completionsTelemetryService);
	ctx.set(CompletionsTelemetryServiceBridge, completionsTelemetryService);

	const promiseQueue = new PromiseQueue();
	ctx.set(PromiseQueue, promiseQueue);
	serviceCollection.set(ICompletionsPromiseQueueService, promiseQueue);

	const accessor = serviceCollection.createTestingAccessor();
	const instantiationService = accessor.get(IInstantiationService);
	ctx.setInstantiationService(instantiationService);

	for (const bridge of bridges) {
		ctx.set(bridge, instantiationService.createInstance(bridge));
	}

	ctx.set(ConfigProvider, configProvider);
	ctx.set(InMemoryConfigProvider, configProvider);
	ctx.set(CopilotTokenManager, instantiationService.createInstance(FakeCopilotTokenManager));
	// Notifications from the monolith when fetching a token can trigger behavior that require these objects.
	ctx.set(TelemetryReporters, new TelemetryReporters());
	ctx.set(NotificationSender, new TestNotificationSender());
	ctx.set(UrlOpener, new TestUrlOpener());
	ctx.set(TelemetryLogSender, new TelemetryLogSenderImpl());
	ctx.set(TelemetryUserConfig, instantiationService.createInstance(TelemetryUserConfig));
	ctx.set(UserErrorNotifier, new UserErrorNotifier());
	ctx.set(Features, instantiationService.createInstance(Features));
	ctx.set(CompletionsCache, new CompletionsCache());
	ctx.set(BlockModeConfig, new ConfigBlockModeConfig());
	ctx.set(StatusReporter, new NoOpStatusReporter());
	ctx.set(CompletionNotifier, instantiationService.createInstance(CompletionNotifier));
	//ctx.set(FileSearch, new TestingFileSearch());
	ctx.set(CompletionsPromptFactory, createCompletionsPromptFactory(instantiationService));
	ctx.set(LastGhostText, new LastGhostText());
	ctx.set(CurrentGhostText, new CurrentGhostText());
	ctx.set(ForceMultiLine, ForceMultiLine.default);
	ctx.set(AvailableModelsManager, instantiationService.createInstance(AvailableModelsManager, false));
	ctx.set(FileReader, instantiationService.createInstance(FileReader));
	ctx.set(CitationManager, new NoOpCitationManager());
	ctx.set(ContextProviderStatistics, new ContextProviderStatistics());
	ctx.set(
		ContextProviderRegistry,
		getContextProviderRegistry(instantiationService, (_, documentSelector, documentContext) => {
			if (documentSelector.find(ds => ds === '*')) {
				return 1;
			}
			return documentSelector.find(ds => typeof ds !== 'string' && ds.language === documentContext.languageId)
				? 10
				: 0;
		}, true)
	);
	ctx.set(ContextProviderBridge, instantiationService.createInstance(ContextProviderBridge));
	ctx.set(AsyncCompletionManager, instantiationService.createInstance(AsyncCompletionManager));
	ctx.set(RecentEditsProvider, new EmptyRecentEditsProvider());
	ctx.set(SpeculativeRequestCache, new SpeculativeRequestCache());

	return accessor;
}

/**
 * @returns a context suitable for `lib` tests.
 */
export function createLibTestingContext() {
	const services = createExtensionTestingServices();
	const accessor = _createBaselineContext(services, new InMemoryConfigProvider(new DefaultsOnlyConfigProvider(), new Map()));
	const ctx = accessor.get(ICompletionsContextService);

	ctx.set(Fetcher, new NoFetchFetcher());
	ctx.set(EditorAndPluginInfo, new LibTestsEditorInfo());
	ctx.set(TextDocumentManager, ctx.instantiationService.createInstance(TestTextDocumentManager));
	ctx.set(FileSystem, new LocalFileSystem());
	ctx.set(CopilotContentExclusionManager, ctx.instantiationService.createInstance(CopilotContentExclusionManager));
	ctx.set(DefaultContextProviders, new DefaultContextProvidersContainer());

	return accessor;
}

export class LibTestsEditorInfo extends EditorAndPluginInfo {
	constructor(
		readonly editorPluginInfo = { name: 'lib-tests-plugin', version: '2' },
		readonly editorInfo = { name: 'lib-tests-editor', version: '1' },
		readonly relatedPluginInfo = [{ name: 'lib-tests-related-plugin', version: '3' }]
	) {
		super();
	}
	getEditorInfo() {
		return this.editorInfo;
	}
	getEditorPluginInfo() {
		return this.editorPluginInfo;
	}
	getRelatedPluginInfo() {
		return this.relatedPluginInfo;
	}
}
