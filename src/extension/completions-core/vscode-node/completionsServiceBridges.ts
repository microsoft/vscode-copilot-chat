/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompletionsAuthenticationServiceBridge } from './bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsEndpointProviderBridge } from './bridge/src/completionsEndpointProviderBridge';
import { CompletionsExperimentationServiceBridge } from './bridge/src/completionsExperimentationServiceBridge';
import { CompletionsIgnoreServiceBridge } from './bridge/src/completionsIgnoreServiceBridge';
import { CompletionsTelemetryServiceBridge } from './bridge/src/completionsTelemetryServiceBridge';
import { CopilotTokenManager } from './lib/src/auth/copilotTokenManager';
import { CitationManager } from './lib/src/citationManager';
import { CompletionNotifier } from './lib/src/completionNotifier';
import { BuildInfo, ConfigProvider, EditorAndPluginInfo, EditorSession } from './lib/src/config';
import { CopilotContentExclusionManager } from './lib/src/contentExclusion/contentExclusionManager';
import { Context } from './lib/src/context';
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
import { RuntimeMode } from './lib/src/testing/runtimeMode';
import { TextDocumentManager } from './lib/src/textDocumentManager';
import { UrlOpener } from './lib/src/util/opener';
import { PromiseQueue } from './lib/src/util/promiseQueue';
import { env, UIKind } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { VSCodeWorkspace } from '../../inlineEdits/vscode-node/parts/vscodeWorkspace';
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
import { CompletionsCapiBridge } from './bridge/src/completionsCapiBridge';

const bridges: any[] = [];

bridges.push(CompletionsIgnoreServiceBridge);
bridges.push(CompletionsTelemetryServiceBridge);
bridges.push(CompletionsExperimentationServiceBridge);
bridges.push(CompletionsAuthenticationServiceBridge);
bridges.push(CompletionsEndpointProviderBridge);
bridges.push(CompletionsCapiBridge);

/** @public */
export function createContext(serviceAccessor: ServicesAccessor): Context {
	const instaService = serviceAccessor.get(IInstantiationService);
	const logService = serviceAccessor.get(ILogService);
	const fetcherService = serviceAccessor.get(IFetcherService);
	const registryService = serviceAccessor.get(ILanguageContextProviderService);
	const extensionContext = serviceAccessor.get(IVSCodeExtensionContext);
	const configurationService = serviceAccessor.get(IConfigurationService);
	const experimentationService = serviceAccessor.get(IExperimentationService);

	const ctx = new Context();

	// Bridges
	for (const bridge of bridges) {
		ctx.set(bridge, instaService.createInstance(bridge));
	}

	ctx.set(Extension, new Extension(extensionContext));
	ctx.set(ConfigProvider, new VSCodeConfigProvider());
	ctx.set(CopilotContentExclusionManager, new CopilotContentExclusionManager(ctx));
	ctx.set(RuntimeMode, RuntimeMode.fromEnvironment(false));
	ctx.set(BuildInfo, new BuildInfo());
	ctx.set(CompletionsCache, new CompletionsCache());
	ctx.set(Features, new Features(ctx));
	ctx.set(TelemetryLogSender, new TelemetryLogSenderImpl());
	ctx.set(TelemetryUserConfig, new TelemetryUserConfig(ctx));
	ctx.set(UserErrorNotifier, new UserErrorNotifier());
	ctx.set(OpenAIFetcher, new LiveOpenAIFetcher());
	ctx.set(BlockModeConfig, new ConfigBlockModeConfig());
	ctx.set(PromiseQueue, new PromiseQueue());
	ctx.set(CompletionNotifier, new CompletionNotifier(ctx));
	ctx.set(FileReader, new FileReader(ctx));
	try {
		ctx.set(CompletionsPromptFactory, createCompletionsPromptFactory(ctx));
	} catch (e) {
		console.log(e);
	}
	ctx.set(LastGhostText, new LastGhostText());
	ctx.set(CurrentGhostText, new CurrentGhostText());
	ctx.set(AvailableModelsManager, new AvailableModelsManager(ctx));
	ctx.set(AsyncCompletionManager, new AsyncCompletionManager(ctx));
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
	ctx.set(EditorSession, new EditorSession(env.sessionId, env.machineId, env.remoteName, uiKindToString(env.uiKind)));
	ctx.set(CopilotExtensionStatus, new CopilotExtensionStatus());
	ctx.set(CopilotTokenManager, new CopilotTokenManager(ctx));
	ctx.set(StatusReporter, new CopilotStatusBar(ctx));
	ctx.set(TextDocumentManager, new ExtensionTextDocumentManager(ctx));
	ctx.set(ObservableWorkspace, instaService.createInstance(VSCodeWorkspace));
	ctx.set(RecentEditsProvider, new FullRecentEditsProvider(ctx));
	ctx.set(FileSystem, extensionFileSystem);
	ctx.set(RelatedFilesProvider, new CompositeRelatedFilesProvider(ctx));
	ctx.set(ContextProviderStatistics, new ContextProviderStatistics());
	ctx.set(ContextProviderRegistry, getContextProviderRegistry(ctx, contextProviderMatch, registryService));
	ctx.set(ContextProviderBridge, new ContextProviderBridge(ctx));
	ctx.set(DefaultContextProviders, new DefaultContextProvidersContainer());
	ctx.set(ForceMultiLine, ForceMultiLine.default);
	ctx.set(UrlOpener, new class extends UrlOpener {
		async open(target: string) {
			await env.openExternal(URI.parse(target));
		}
	});

	ctx.set(LogTarget, new class extends LogTarget {
		override logIt(ctx: Context, level: LogLevel, category: string, ...extra: unknown[]): void {
			const msg = formatLogMessage(category, ...extra);
			switch (level) {
				case LogLevel.DEBUG: return logService.debug(msg);
				case LogLevel.INFO: return logService.info(msg);
				case LogLevel.WARN: return logService.warn(msg);
				case LogLevel.ERROR: return logService.error(msg);
			}
		}
	});

	return ctx;
}

/** @public */
export function setup(ctx: Context): IDisposable {
	const disposables = new DisposableStore();

	// This must be registered before activation!
	// CodeQuote needs to listen for the initial token notification event.
	const codeReference = new CodeReference(ctx);
	ctx.set(CitationManager, new LoggingCitationManager(codeReference));
	disposables.add(codeReference.register());

	// Send telemetry when ghost text is accepted
	disposables.add(registerGhostTextDependencies(ctx));

	// Register to listen for changes to the active document to keep track
	// of last access time
	disposables.add(registerDocumentTracker(ctx));

	// Register the context providers enabled by default.
	ctx.get(DefaultContextProviders).add('ms-vscode.cpptools');

	disposables.add(setupCompletionsExperimentationService(ctx));

	return disposables;
}

function uiKindToString(uiKind: UIKind): string {
	switch (uiKind) {
		case UIKind.Desktop:
			return 'desktop';
		case UIKind.Web:
			return 'web';
	}
}
