/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsEndpointProviderBridge } from '../../../bridge/src/completionsEndpointProviderBridge';
import { CompletionsExperimentationServiceBridge } from '../../../bridge/src/completionsExperimentationServiceBridge';
import { CompletionsIgnoreServiceBridge } from '../../../bridge/src/completionsIgnoreServiceBridge';
import { CompletionsTelemetryServiceBridge } from '../../../bridge/src/completionsTelemetryServiceBridge';
import { CopilotTokenManager } from '../auth/copilotTokenManager';
import { CitationManager, NoOpCitationManager } from '../citationManager';
import { CompletionNotifier } from '../completionNotifier';
import {
	BuildInfo,
	ConfigProvider,
	DefaultsOnlyConfigProvider,
	EditorAndPluginInfo,
	EditorSession,
	InMemoryConfigProvider,
} from '../config';
import { CopilotContentExclusionManager } from '../contentExclusion/contentExclusionManager';
import { Context } from '../context';
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
import { PromiseQueue } from '../util/promiseQueue';
import { NoFetchFetcher } from './fetcher';
import { RuntimeMode } from './runtimeMode';
import { TestNotificationSender, TestUrlOpener } from './testHelpers';
import { TestTextDocumentManager } from './textDocument';

import { NullLanguageContextProviderService } from '../../../../../../platform/languageContextProvider/common/nullLanguageContextProviderService';
import { IInstantiationService, type ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionTestingServices } from '../../../../../test/vscode-node/services';

class NullLog extends LogTarget {
	logIt(..._: unknown[]) { }
}

const nullLanguageContextProviderService: NullLanguageContextProviderService = new NullLanguageContextProviderService();
const bridges: any[] = [];
bridges.push(CompletionsEndpointProviderBridge);
bridges.push(CompletionsAuthenticationServiceBridge);
bridges.push(CompletionsIgnoreServiceBridge);
bridges.push(CompletionsExperimentationServiceBridge);
bridges.push(CompletionsTelemetryServiceBridge);

/**
 * Baseline for a context. Tests should prefer the specific variants outlined below.
 *
 * @see createLibTestingContext
 * @see createExtensionTestingContext
 * @see createAgentTestingContext
 */
export function _createBaselineContext(serviceAccessor: ServicesAccessor, configProvider: InMemoryConfigProvider): Context {
	const instaService = serviceAccessor.get(IInstantiationService);
	const ctx = new Context();
	for (const bridge of bridges) {
		ctx.set(bridge, instaService.createInstance(bridge));
	}

	ctx.set(ConfigProvider, configProvider);
	ctx.set(InMemoryConfigProvider, configProvider);
	ctx.set(BuildInfo, new BuildInfo());
	ctx.set(RuntimeMode, new RuntimeMode({ debug: false, verboseLogging: false, testMode: true, simulation: false }));
	ctx.set(CopilotTokenManager, new CopilotTokenManager(ctx, true));
	// Notifications from the monolith when fetching a token can trigger behavior that require these objects.
	ctx.set(TelemetryReporters, new TelemetryReporters());
	ctx.set(NotificationSender, new TestNotificationSender());
	ctx.set(UrlOpener, new TestUrlOpener());
	ctx.set(TelemetryLogSender, new TelemetryLogSenderImpl());
	ctx.set(TelemetryUserConfig, new TelemetryUserConfig(ctx));
	ctx.set(LogTarget, new NullLog());
	ctx.set(UserErrorNotifier, new UserErrorNotifier());
	ctx.set(EditorSession, new EditorSession('test-session', 'test-machine'));
	ctx.set(Features, new Features(ctx));
	ctx.set(CompletionsCache, new CompletionsCache());
	ctx.set(BlockModeConfig, new ConfigBlockModeConfig());
	ctx.set(StatusReporter, new NoOpStatusReporter());
	ctx.set(PromiseQueue, new PromiseQueue());
	ctx.set(CompletionNotifier, new CompletionNotifier(ctx));
	//ctx.set(FileSearch, new TestingFileSearch());
	ctx.set(CompletionsPromptFactory, createCompletionsPromptFactory(ctx));
	ctx.set(LastGhostText, new LastGhostText());
	ctx.set(CurrentGhostText, new CurrentGhostText());
	ctx.set(ForceMultiLine, ForceMultiLine.default);
	ctx.set(AvailableModelsManager, new AvailableModelsManager(ctx, false));
	ctx.set(FileReader, new FileReader(ctx));
	ctx.set(CitationManager, new NoOpCitationManager());
	ctx.set(ContextProviderStatistics, new ContextProviderStatistics());
	ctx.set(
		ContextProviderRegistry,
		getContextProviderRegistry(ctx, (_, documentSelector, documentContext) => {
			if (documentSelector.find(ds => ds === '*')) {
				return 1;
			}
			return documentSelector.find(ds => typeof ds !== 'string' && ds.language === documentContext.languageId)
				? 10
				: 0;
		}, nullLanguageContextProviderService, true)
	);
	ctx.set(ContextProviderBridge, new ContextProviderBridge(ctx));
	registerConversation(ctx);
	ctx.set(AsyncCompletionManager, new AsyncCompletionManager(ctx));
	ctx.set(RecentEditsProvider, new EmptyRecentEditsProvider());
	ctx.set(SpeculativeRequestCache, new SpeculativeRequestCache());

	return ctx;
}

function registerConversation(ctx: Context) {
}

/**
 * @returns a context suitable for `lib` tests.
 */
export function createLibTestingContext() {
	const services = createExtensionTestingServices();
	const accessor = services.createTestingAccessor();
	const ctx = _createBaselineContext(accessor, new InMemoryConfigProvider(new DefaultsOnlyConfigProvider(), new Map()));

	ctx.set(Fetcher, new NoFetchFetcher());
	ctx.set(EditorAndPluginInfo, new LibTestsEditorInfo());
	ctx.set(TextDocumentManager, new TestTextDocumentManager(ctx));
	ctx.set(FileSystem, new LocalFileSystem());
	ctx.set(CopilotContentExclusionManager, new CopilotContentExclusionManager(ctx));
	ctx.set(DefaultContextProviders, new DefaultContextProvidersContainer());

	return ctx;
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
