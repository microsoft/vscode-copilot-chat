/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { env, UIKind } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { VSCodeWorkspace } from '../../inlineEdits/vscode-node/parts/vscodeWorkspace';
import { CompletionsAuthenticationServiceBridge } from './bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsCapiBridge } from './bridge/src/completionsCapiBridge';
import { CompletionsEndpointProviderBridge } from './bridge/src/completionsEndpointProviderBridge';
import { CompletionsExperimentationServiceBridge } from './bridge/src/completionsExperimentationServiceBridge';
import { CompletionsIgnoreServiceBridge } from './bridge/src/completionsIgnoreServiceBridge';
import { CompletionsTelemetryServiceBridge, ICompletionsTelemetryService } from './bridge/src/completionsTelemetryServiceBridge';
import { CodeReference } from './extension/src/codeReferencing';
import { LoggingCitationManager } from './extension/src/codeReferencing/citationManager';
import { VSCodeConfigProvider, VSCodeEditorInfo } from './extension/src/config';
import { contextProviderMatch } from './extension/src/contextProviderMatch';
import { Extension } from './extension/src/extensionContext';
import { CopilotExtensionStatus } from './extension/src/extensionStatus';
import { extensionFileSystem } from './extension/src/fileSystem';
import { registerGhostTextDependencies } from './extension/src/ghostText/ghostText';
import { CopilotStatusBar } from './extension/src/statusBar';
import { ExtensionTextDocumentManager } from './extension/src/textDocumentManager';
import { CopilotTokenManager, CopilotTokenManagerImpl } from './lib/src/auth/copilotTokenManager';
import { CitationManager } from './lib/src/citationManager';
import { CompletionNotifier } from './lib/src/completionNotifier';
import { BuildInfo, ConfigProvider, EditorAndPluginInfo, EditorSession, ICompletionsBuildInfoService, ICompletionsEditorSessionService } from './lib/src/config';
import { CopilotContentExclusionManager } from './lib/src/contentExclusion/contentExclusionManager';
import { Context, ICompletionsContextService } from './lib/src/context';
import { registerDocumentTracker } from './lib/src/documentTracker';
import { UserErrorNotifier } from './lib/src/error/userErrorNotifier';
import { setupCompletionsExperimentationService } from './lib/src/experiments/defaultExpFilters';
import { Features } from './lib/src/experiments/features';
import { FileReader } from './lib/src/fileReader';
import { FileSystem } from './lib/src/fileSystem';
import { AsyncCompletionManager } from './lib/src/ghostText/asyncCompletions';
import { CompletionsCache } from './lib/src/ghostText/completionsCache';
import { BlockModeConfig, ConfigBlockModeConfig } from './lib/src/ghostText/configBlockMode';
import { CurrentGhostText } from './lib/src/ghostText/current';
import { ForceMultiLine } from './lib/src/ghostText/ghostText';
import { LastGhostText } from './lib/src/ghostText/last';
import { SpeculativeRequestCache } from './lib/src/ghostText/speculativeRequestCache';
import { LogLevel, LogTarget, TelemetryLogSender } from './lib/src/logger';
import { TelemetryLogSenderImpl } from './lib/src/logging/telemetryLogSender';
import { formatLogMessage } from './lib/src/logging/util';
import { Fetcher, FetchOptions, Response } from './lib/src/networking';
import { ExtensionNotificationSender, NotificationSender } from './lib/src/notificationSender';
import { LiveOpenAIFetcher, OpenAIFetcher } from './lib/src/openai/fetch';
import { AvailableModelsManager } from './lib/src/openai/model';
import { StatusReporter } from './lib/src/progress';
import {
	CompletionsPromptFactory,
	createCompletionsPromptFactory,
} from './lib/src/prompt/completionsPromptFactory/completionsPromptFactory';
import { ContextProviderBridge } from './lib/src/prompt/components/contextProviderBridge';
import {
	ContextProviderRegistry,
	DefaultContextProviders,
	DefaultContextProvidersContainer,
	getContextProviderRegistry,
} from './lib/src/prompt/contextProviderRegistry';
import { ContextProviderStatistics } from './lib/src/prompt/contextProviderStatistics';
import { FullRecentEditsProvider, RecentEditsProvider } from './lib/src/prompt/recentEdits/recentEditsProvider';
import { CompositeRelatedFilesProvider } from './lib/src/prompt/similarFiles/compositeRelatedFilesProvider';
import { RelatedFilesProvider } from './lib/src/prompt/similarFiles/relatedFiles';
import { TelemetryUserConfig } from './lib/src/telemetry';
import { TextDocumentManager } from './lib/src/textDocumentManager';
import { UrlOpener } from './lib/src/util/opener';
import { ICompletionsPromiseQueueService, PromiseQueue } from './lib/src/util/promiseQueue';
import { ICompletionsRuntimeModeService, RuntimeMode } from './lib/src/util/runtimeMode';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';

const bridges: any[] = [];

bridges.push(CompletionsIgnoreServiceBridge);
bridges.push(CompletionsExperimentationServiceBridge);
bridges.push(CompletionsAuthenticationServiceBridge);
bridges.push(CompletionsEndpointProviderBridge);
bridges.push(CompletionsCapiBridge);

/** @public */
export function createContext(serviceAccessor: ServicesAccessor): IInstantiationService {
	const logService = serviceAccessor.get(ILogService);
	const fetcherService = serviceAccessor.get(IFetcherService);
	const extensionContext = serviceAccessor.get(IVSCodeExtensionContext);
	const configurationService = serviceAccessor.get(IConfigurationService);
	const experimentationService = serviceAccessor.get(IExperimentationService);

	const serviceCollection = new ServiceCollection();

	const ctx = new Context();
	serviceCollection.set(ICompletionsContextService, ctx);

	ctx.set(LogTarget, new class extends LogTarget {
		override logIt(level: LogLevel, category: string, ...extra: unknown[]): void {
			const msg = formatLogMessage(category, ...extra);
			switch (level) {
				case LogLevel.DEBUG: return logService.debug(msg);
				case LogLevel.INFO: return logService.info(msg);
				case LogLevel.WARN: return logService.warn(msg);
				case LogLevel.ERROR: return logService.error(msg);
			}
		}
	});

	const runtimeMode = RuntimeMode.fromEnvironment(false);
	ctx.set(RuntimeMode, runtimeMode);
	serviceCollection.set(ICompletionsRuntimeModeService, runtimeMode);

	const buildInfo = new BuildInfo();
	ctx.set(BuildInfo, buildInfo);
	serviceCollection.set(ICompletionsBuildInfoService, buildInfo);

	const editorSession = new EditorSession(env.sessionId, env.machineId, env.remoteName, uiKindToString(env.uiKind));
	ctx.set(EditorSession, editorSession);
	serviceCollection.set(ICompletionsEditorSessionService, editorSession);

	const completionsTelemetryService = new CompletionsTelemetryServiceBridge(serviceAccessor.get(ITelemetryService));
	serviceCollection.set(ICompletionsTelemetryService, completionsTelemetryService);
	ctx.set(CompletionsTelemetryServiceBridge, completionsTelemetryService);

	const promiseQueue = new PromiseQueue();
	ctx.set(PromiseQueue, promiseQueue);
	serviceCollection.set(ICompletionsPromiseQueueService, promiseQueue);

	const instantiationService = serviceAccessor.get(IInstantiationService).createChild(serviceCollection);
	ctx.setInstantiationService(instantiationService);

	// Bridges
	for (const bridge of bridges) {
		ctx.set(bridge, instantiationService.createInstance(bridge));
	}

	ctx.set(Extension, new Extension(extensionContext));
	ctx.set(ConfigProvider, new VSCodeConfigProvider());
	ctx.set(CopilotContentExclusionManager, instantiationService.createInstance(CopilotContentExclusionManager));
	ctx.set(CompletionsCache, new CompletionsCache());
	ctx.set(Features, instantiationService.createInstance(Features));
	ctx.set(TelemetryLogSender, new TelemetryLogSenderImpl());
	ctx.set(TelemetryUserConfig, instantiationService.createInstance(TelemetryUserConfig));
	ctx.set(UserErrorNotifier, new UserErrorNotifier());
	ctx.set(OpenAIFetcher, new LiveOpenAIFetcher(instantiationService, ctx, runtimeMode));
	ctx.set(BlockModeConfig, new ConfigBlockModeConfig());
	ctx.set(CompletionNotifier, instantiationService.createInstance(CompletionNotifier));
	ctx.set(FileReader, instantiationService.createInstance(FileReader));
	try {
		ctx.set(CompletionsPromptFactory, createCompletionsPromptFactory(instantiationService));
	} catch (e) {
		console.log(e);
	}
	ctx.set(LastGhostText, new LastGhostText());
	ctx.set(CurrentGhostText, new CurrentGhostText());
	ctx.set(AvailableModelsManager, instantiationService.createInstance(AvailableModelsManager, true));
	ctx.set(AsyncCompletionManager, instantiationService.createInstance(AsyncCompletionManager));
	ctx.set(SpeculativeRequestCache, new SpeculativeRequestCache());

	ctx.set(Fetcher, new class extends Fetcher {
		override get name(): string {
			return 'vscode-copilot-chat-fetcherService'; // TODO: remove this
		}
		override fetch(url: string, options: FetchOptions): Promise<Response> {
			const useFetcher = configurationService.getExperimentBasedConfig(ConfigKey.CompletionsFetcher, experimentationService) || undefined;
			return fetcherService.fetch(url, useFetcher ? { ...options, useFetcher } : options);
		}
		override disconnectAll(): Promise<unknown> {
			return fetcherService.disconnectAll();
		}
	});

	ctx.set(NotificationSender, new ExtensionNotificationSender());
	ctx.set(EditorAndPluginInfo, new VSCodeEditorInfo());
	ctx.set(CopilotExtensionStatus, new CopilotExtensionStatus());
	ctx.set(CopilotTokenManager, instantiationService.createInstance(CopilotTokenManagerImpl, false));
	ctx.set(StatusReporter, instantiationService.createInstance(CopilotStatusBar, 'github.copilot.languageStatus'));
	ctx.set(TextDocumentManager, instantiationService.createInstance(ExtensionTextDocumentManager));
	ctx.set(ObservableWorkspace, instantiationService.createInstance(VSCodeWorkspace));
	ctx.set(RecentEditsProvider, instantiationService.createInstance(FullRecentEditsProvider, undefined));
	ctx.set(FileSystem, extensionFileSystem);
	ctx.set(RelatedFilesProvider, instantiationService.createInstance(CompositeRelatedFilesProvider));
	ctx.set(ContextProviderStatistics, new ContextProviderStatistics());
	ctx.set(ContextProviderRegistry, getContextProviderRegistry(instantiationService, contextProviderMatch));
	ctx.set(ContextProviderBridge, instantiationService.createInstance(ContextProviderBridge));
	ctx.set(DefaultContextProviders, new DefaultContextProvidersContainer());
	ctx.set(ForceMultiLine, ForceMultiLine.default);
	ctx.set(UrlOpener, new class extends UrlOpener {
		async open(target: string) {
			await env.openExternal(URI.parse(target));
		}
	});

	return instantiationService;
}

/** @public */
export function setup(serviceAccessor: ServicesAccessor): IDisposable {
	const disposables = new DisposableStore();
	const instantiationService = serviceAccessor.get(IInstantiationService);
	const ctx = serviceAccessor.get(ICompletionsContextService);

	// This must be registered before activation!
	// CodeQuote needs to listen for the initial token notification event.
	const codeReference = instantiationService.createInstance(CodeReference);
	ctx.set(CitationManager, new LoggingCitationManager(codeReference, instantiationService));
	disposables.add(codeReference.register());

	// Send telemetry when ghost text is accepted
	disposables.add(registerGhostTextDependencies(serviceAccessor));

	// Register to listen for changes to the active document to keep track
	// of last access time
	disposables.add(registerDocumentTracker(serviceAccessor));

	// Register the context providers enabled by default.
	ctx.get(DefaultContextProviders).add('ms-vscode.cpptools');

	disposables.add(setupCompletionsExperimentationService(serviceAccessor));

	return disposables;
}

function uiKindToString(uiKind: UIKind): 'desktop' | 'web' {
	switch (uiKind) {
		case UIKind.Desktop:
			return 'desktop';
		case UIKind.Web:
			return 'web';
	}
}
