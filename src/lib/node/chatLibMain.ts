/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { DocumentSelector, Position } from 'vscode-languageserver-protocol';
import { CompletionsAuthenticationServiceBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsCapiBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsCapiBridge';
import { CompletionsEndpointProviderBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsEndpointProviderBridge';
import { CompletionsExperimentationServiceBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsExperimentationServiceBridge';
import { CompletionsIgnoreServiceBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsIgnoreServiceBridge';
import { CompletionsTelemetryServiceBridge } from '../../extension/completions-core/vscode-node/bridge/src/completionsTelemetryServiceBridge';
import { CopilotExtensionStatus } from '../../extension/completions-core/vscode-node/extension/src/extensionStatus';
import { CopilotTokenManager } from '../../extension/completions-core/vscode-node/lib/src/auth/copilotTokenManager';
import { CompletionNotifier } from '../../extension/completions-core/vscode-node/lib/src/completionNotifier';
import { BuildInfo, ConfigProvider, DefaultsOnlyConfigProvider, EditorAndPluginInfo, EditorInfo, EditorPluginInfo, EditorSession, InMemoryConfigProvider } from '../../extension/completions-core/vscode-node/lib/src/config';
import { CopilotContentExclusionManager } from '../../extension/completions-core/vscode-node/lib/src/contentExclusion/contentExclusionManager';
import { Context } from '../../extension/completions-core/vscode-node/lib/src/context';
import { UserErrorNotifier } from '../../extension/completions-core/vscode-node/lib/src/error/userErrorNotifier';
import { Features } from '../../extension/completions-core/vscode-node/lib/src/experiments/features';
import { FileReader } from '../../extension/completions-core/vscode-node/lib/src/fileReader';
import { FileSystem } from '../../extension/completions-core/vscode-node/lib/src/fileSystem';
import { AsyncCompletionManager } from '../../extension/completions-core/vscode-node/lib/src/ghostText/asyncCompletions';
import { CompletionsCache } from '../../extension/completions-core/vscode-node/lib/src/ghostText/completionsCache';
import { BlockModeConfig, ConfigBlockModeConfig } from '../../extension/completions-core/vscode-node/lib/src/ghostText/configBlockMode';
import { CopilotCompletion } from '../../extension/completions-core/vscode-node/lib/src/ghostText/copilotCompletion';
import { CurrentGhostText } from '../../extension/completions-core/vscode-node/lib/src/ghostText/current';
import { ForceMultiLine, GetGhostTextOptions } from '../../extension/completions-core/vscode-node/lib/src/ghostText/ghostText';
import { LastGhostText } from '../../extension/completions-core/vscode-node/lib/src/ghostText/last';
import { ITextEditorOptions } from '../../extension/completions-core/vscode-node/lib/src/ghostText/normalizeIndent';
import { SpeculativeRequestCache } from '../../extension/completions-core/vscode-node/lib/src/ghostText/speculativeRequestCache';
import { getInlineCompletions } from '../../extension/completions-core/vscode-node/lib/src/inlineCompletion';
import { LocalFileSystem } from '../../extension/completions-core/vscode-node/lib/src/localFileSystem';
import { LogLevel as CompletionsLogLevel, LogTarget, TelemetryLogSender } from '../../extension/completions-core/vscode-node/lib/src/logger';
import { TelemetryLogSenderImpl } from '../../extension/completions-core/vscode-node/lib/src/logging/telemetryLogSender';
import { Fetcher } from '../../extension/completions-core/vscode-node/lib/src/networking';
import { ActionItem, NotificationSender } from '../../extension/completions-core/vscode-node/lib/src/notificationSender';
import { LiveOpenAIFetcher, OpenAIFetcher } from '../../extension/completions-core/vscode-node/lib/src/openai/fetch';
import { AvailableModelsManager } from '../../extension/completions-core/vscode-node/lib/src/openai/model';
import { StatusChangedEvent, StatusReporter } from '../../extension/completions-core/vscode-node/lib/src/progress';
import { CompletionsPromptFactory, createCompletionsPromptFactory } from '../../extension/completions-core/vscode-node/lib/src/prompt/completionsPromptFactory/completionsPromptFactory';
import { ContextProviderBridge } from '../../extension/completions-core/vscode-node/lib/src/prompt/components/contextProviderBridge';
import { ContextProviderRegistry, DefaultContextProviders, DefaultContextProvidersContainer, getContextProviderRegistry } from '../../extension/completions-core/vscode-node/lib/src/prompt/contextProviderRegistry';
import { ContextProviderStatistics } from '../../extension/completions-core/vscode-node/lib/src/prompt/contextProviderStatistics';
import { FullRecentEditsProvider, RecentEditsProvider } from '../../extension/completions-core/vscode-node/lib/src/prompt/recentEdits/recentEditsProvider';
import { CompositeRelatedFilesProvider } from '../../extension/completions-core/vscode-node/lib/src/prompt/similarFiles/compositeRelatedFilesProvider';
import { RelatedFilesProvider } from '../../extension/completions-core/vscode-node/lib/src/prompt/similarFiles/relatedFiles';
import { TelemetryUserConfig } from '../../extension/completions-core/vscode-node/lib/src/telemetry';
import { INotebookDocument, ITextDocument, TextDocumentIdentifier } from '../../extension/completions-core/vscode-node/lib/src/textDocument';
import { TextDocumentChangeEvent, TextDocumentCloseEvent, TextDocumentFocusedEvent, TextDocumentManager, TextDocumentOpenEvent, WorkspaceFoldersChangeEvent } from '../../extension/completions-core/vscode-node/lib/src/textDocumentManager';
import { Event } from '../../extension/completions-core/vscode-node/lib/src/util/event';
import { UrlOpener } from '../../extension/completions-core/vscode-node/lib/src/util/opener';
import { PromiseQueue } from '../../extension/completions-core/vscode-node/lib/src/util/promiseQueue';
import { RuntimeMode } from '../../extension/completions-core/vscode-node/lib/src/util/runtimeMode';
import { DocumentContext, WorkspaceFolder } from '../../extension/completions-core/vscode-node/types/src';
import { DebugRecorder } from '../../extension/inlineEdits/node/debugRecorder';
import { INextEditProvider, NextEditProvider } from '../../extension/inlineEdits/node/nextEditProvider';
import { LlmNESTelemetryBuilder, NextEditProviderTelemetryBuilder, TelemetrySender } from '../../extension/inlineEdits/node/nextEditProviderTelemetry';
import { INextEditResult } from '../../extension/inlineEdits/node/nextEditResult';
import { ChatMLFetcherImpl } from '../../extension/prompt/node/chatMLFetcher';
import { XtabProvider } from '../../extension/xtab/node/xtabProvider';
import { IAuthenticationService } from '../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../platform/authentication/common/copilotTokenManager';
import { CopilotTokenStore, ICopilotTokenStore } from '../../platform/authentication/common/copilotTokenStore';
import { StaticGitHubAuthenticationService } from '../../platform/authentication/common/staticGitHubAuthenticationService';
import { createStaticGitHubTokenProvider } from '../../platform/authentication/node/copilotTokenManager';
import { IChatMLFetcher } from '../../platform/chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../platform/chat/common/chatQuotaService';
import { ChatQuotaService } from '../../platform/chat/common/chatQuotaServiceImpl';
import { IConversationOptions } from '../../platform/chat/common/conversationOptions';
import { IInteractionService, InteractionService } from '../../platform/chat/common/interactionService';
import { ConfigKey, IConfigurationService } from '../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../platform/configuration/common/defaultsOnlyConfigurationService';
import { IDiffService } from '../../platform/diff/common/diffService';
import { DiffServiceImpl } from '../../platform/diff/node/diffServiceImpl';
import { ICAPIClientService } from '../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../platform/endpoint/common/domainService';
import { IEndpointProvider } from '../../platform/endpoint/common/endpointProvider';
import { CAPIClientImpl } from '../../platform/endpoint/node/capiClientImpl';
import { DomainService } from '../../platform/endpoint/node/domainServiceImpl';
import { IEnvService } from '../../platform/env/common/envService';
import { NullEnvService } from '../../platform/env/common/nullEnvService';
import { IGitExtensionService } from '../../platform/git/common/gitExtensionService';
import { NullGitExtensionService } from '../../platform/git/common/nullGitExtensionService';
import { IIgnoreService, NullIgnoreService } from '../../platform/ignore/common/ignoreService';
import { DocumentId } from '../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../platform/inlineEdits/common/observableGit';
import { ObservableWorkspace } from '../../platform/inlineEdits/common/observableWorkspace';
import { NesHistoryContextProvider } from '../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILanguageContextProviderService } from '../../platform/languageContextProvider/common/languageContextProviderService';
import { NullLanguageContextProviderService } from '../../platform/languageContextProvider/common/nullLanguageContextProviderService';
import { ILanguageDiagnosticsService } from '../../platform/languages/common/languageDiagnosticsService';
import { TestLanguageDiagnosticsService } from '../../platform/languages/common/testLanguageDiagnosticsService';
import { ConsoleLog, ILogService, LogLevel as InternalLogLevel, LogServiceImpl } from '../../platform/log/common/logService';
import { FetchOptions, IAbortController, IFetcherService } from '../../platform/networking/common/fetcherService';
import { IFetcher } from '../../platform/networking/common/networking';
import { NullRequestLogger } from '../../platform/requestLogger/node/nullRequestLogger';
import { IRequestLogger } from '../../platform/requestLogger/node/requestLogger';
import { ISimulationTestContext, NulSimulationTestContext } from '../../platform/simulationTestContext/common/simulationTestContext';
import { ISnippyService, NullSnippyService } from '../../platform/snippy/common/snippyService';
import { IExperimentationService, TreatmentsChangeEvent } from '../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryDestination, TelemetryEventMeasurements, TelemetryEventProperties } from '../../platform/telemetry/common/telemetry';
import { eventPropertiesToSimpleObject } from '../../platform/telemetry/common/telemetryData';
import { ITokenizerProvider, TokenizerProvider } from '../../platform/tokenizer/node/tokenizer';
import { IWorkspaceService, NullWorkspaceService } from '../../platform/workspace/common/workspaceService';
import { InstantiationServiceBuilder } from '../../util/common/services';
import { CancellationToken } from '../../util/vs/base/common/cancellation';
import { Emitter } from '../../util/vs/base/common/event';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';
export {
	IAuthenticationService, ICAPIClientService, IEndpointProvider, IExperimentationService, IIgnoreService, ILanguageContextProviderService
};

/**
 * Log levels (taken from vscode.d.ts)
 */
export enum LogLevel {

	/**
	 * No messages are logged with this level.
	 */
	Off = 0,

	/**
	 * All messages are logged with this level.
	 */
	Trace = 1,

	/**
	 * Messages with debug and higher log level are logged with this level.
	 */
	Debug = 2,

	/**
	 * Messages with info and higher log level are logged with this level.
	 */
	Info = 3,

	/**
	 * Messages with warning and higher log level are logged with this level.
	 */
	Warning = 4,

	/**
	 * Only error messages are logged with this level.
	 */
	Error = 5
}

export interface ILogTarget {
	logIt(level: LogLevel, metadataStr: string, ...extra: any[]): void;
	show?(preserveFocus?: boolean): void;
}

export interface ITelemetrySender {
	sendTelemetryEvent(eventName: string, properties?: Record<string, string | undefined>, measurements?: Record<string, number | undefined>): void;
}

export interface INESProviderOptions {
	readonly workspace: ObservableWorkspace;
	readonly fetcher: IFetcher;
	readonly copilotTokenManager: ICopilotTokenManager;
	readonly telemetrySender: ITelemetrySender;
	readonly logTarget?: ILogTarget;
	/**
	 * If true, the provider will wait for treatment variables to be set.
	 * INESProvider.updateTreatmentVariables() must be called to unblock.
	 */
	readonly waitForTreatmentVariables?: boolean;
}

export interface INESResult {
	readonly result?: {
		readonly newText: string;
		readonly range: {
			readonly start: number;
			readonly endExclusive: number;
		};
	};
}

export interface INESProvider<T extends INESResult = INESResult> {
	getId(): string;
	getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<T>;
	handleShown(suggestion: T): void;
	handleAcceptance(suggestion: T): void;
	handleRejection(suggestion: T): void;
	handleIgnored(suggestion: T, supersededByRequestUuid: T | undefined): void;
	updateTreatmentVariables(variables: Record<string, boolean | number | string>): void;
	dispose(): void;
}

export function createNESProvider(options: INESProviderOptions): INESProvider<INESResult> {
	const instantiationService = setupServices(options);
	return instantiationService.createInstance(NESProvider, options);
}

interface NESResult extends INESResult {
	docId: DocumentId;
	requestUuid: string;
	internalResult: INextEditResult;
	telemetryBuilder: NextEditProviderTelemetryBuilder;
}

class NESProvider extends Disposable implements INESProvider<NESResult> {
	private readonly _nextEditProvider: INextEditProvider<INextEditResult, LlmNESTelemetryBuilder>;
	private readonly _telemetrySender: TelemetrySender;
	private readonly _debugRecorder: DebugRecorder;

	constructor(
		private _options: INESProviderOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();
		const statelessNextEditProvider = instantiationService.createInstance(XtabProvider);
		const git = instantiationService.createInstance(ObservableGit);
		const historyContextProvider = new NesHistoryContextProvider(this._options.workspace, git);
		const xtabDiffNEntries = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsXtabDiffNEntries, this._expService);
		const xtabHistoryTracker = new NesXtabHistoryTracker(this._options.workspace, xtabDiffNEntries);
		this._debugRecorder = this._register(new DebugRecorder(this._options.workspace));

		this._nextEditProvider = instantiationService.createInstance(NextEditProvider, this._options.workspace, statelessNextEditProvider, historyContextProvider, xtabHistoryTracker, this._debugRecorder);
		this._telemetrySender = this._register(instantiationService.createInstance(TelemetrySender));
	}

	getId(): string {
		return this._nextEditProvider.ID;
	}

	handleShown(result: NESResult): void {
		result.telemetryBuilder.setAsShown();
		this._nextEditProvider.handleShown(result.internalResult);
	}

	handleAcceptance(result: NESResult): void {
		result.telemetryBuilder.setAcceptance('accepted');
		result.telemetryBuilder.setStatus('accepted');
		this._nextEditProvider.handleAcceptance(result.docId, result.internalResult);
		this.handleEndOfLifetime(result);
	}

	handleRejection(result: NESResult): void {
		result.telemetryBuilder.setAcceptance('rejected');
		result.telemetryBuilder.setStatus('rejected');
		this._nextEditProvider.handleRejection(result.docId, result.internalResult);
		this.handleEndOfLifetime(result);
	}

	handleIgnored(result: NESResult, supersededByRequestUuid: NESResult | undefined): void {
		if (supersededByRequestUuid) {
			result.telemetryBuilder.setSupersededBy(supersededByRequestUuid.requestUuid);
		}
		this._nextEditProvider.handleIgnored(result.docId, result.internalResult, supersededByRequestUuid?.internalResult);
		this.handleEndOfLifetime(result);
	}

	private handleEndOfLifetime(result: NESResult): void {
		try {
			this._telemetrySender.sendTelemetryForBuilder(result.telemetryBuilder);
		} finally {
			result.telemetryBuilder.dispose();
		}
	}

	async getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<NESResult> {
		const docId = DocumentId.create(documentUri.toString());

		// Create minimal required context objects
		const context: vscode.InlineCompletionContext = {
			triggerKind: 1, // Invoke
			selectedCompletionInfo: undefined,
			requestUuid: generateUuid(),
			requestIssuedDateTime: Date.now(),
			earliestShownDateTime: Date.now() + 200,
		};

		// Create log context
		const logContext = new InlineEditRequestLogContext(documentUri.toString(), 1, context);

		const document = this._options.workspace.getDocument(docId);
		if (!document) {
			throw new Error('DocumentNotFound');
		}

		// Create telemetry builder - we'll need to pass null/undefined for services we don't have
		const telemetryBuilder = new NextEditProviderTelemetryBuilder(
			new NullGitExtensionService(),
			undefined, // INotebookService
			this._workspaceService,
			this._nextEditProvider.ID,
			document,
			this._debugRecorder,
			logContext.recordingBookmark
		);
		telemetryBuilder.setOpportunityId(context.requestUuid);

		try {
			const internalResult = await this._nextEditProvider.getNextEdit(docId, context, logContext, cancellationToken, telemetryBuilder.nesBuilder);
			const result: NESResult = {
				result: internalResult.result ? {
					newText: internalResult.result.edit.newText,
					range: internalResult.result.edit.replaceRange,
				} : undefined,
				docId,
				requestUuid: context.requestUuid,
				internalResult,
				telemetryBuilder,
			};
			return result;
		} catch (e) {
			try {
				this._telemetrySender.sendTelemetryForBuilder(telemetryBuilder);
			} finally {
				telemetryBuilder.dispose();
			}
			throw e;
		}
	}

	updateTreatmentVariables(variables: Record<string, boolean | number | string>) {
		if (this._expService instanceof SimpleExperimentationService) {
			this._expService.updateTreatmentVariables(variables);
		}
	}

}

function setupServices(options: INESProviderOptions) {
	const { fetcher, copilotTokenManager, telemetrySender, logTarget } = options;
	const builder = new InstantiationServiceBuilder();
	builder.define(IConfigurationService, new SyncDescriptor(DefaultsOnlyConfigurationService));
	builder.define(IExperimentationService, new SyncDescriptor(SimpleExperimentationService, [options.waitForTreatmentVariables]));
	builder.define(ISimulationTestContext, new SyncDescriptor(NulSimulationTestContext));
	builder.define(IWorkspaceService, new SyncDescriptor(NullWorkspaceService));
	builder.define(IDiffService, new SyncDescriptor(DiffServiceImpl, [false]));
	builder.define(ILogService, new SyncDescriptor(LogServiceImpl, [[logTarget || new ConsoleLog(undefined, InternalLogLevel.Trace)]]));
	builder.define(IGitExtensionService, new SyncDescriptor(NullGitExtensionService));
	builder.define(ILanguageContextProviderService, new SyncDescriptor(NullLanguageContextProviderService));
	builder.define(ILanguageDiagnosticsService, new SyncDescriptor(TestLanguageDiagnosticsService));
	builder.define(IIgnoreService, new SyncDescriptor(NullIgnoreService));
	builder.define(ISnippyService, new SyncDescriptor(NullSnippyService));
	builder.define(IDomainService, new SyncDescriptor(DomainService));
	builder.define(ICAPIClientService, new SyncDescriptor(CAPIClientImpl));
	builder.define(ICopilotTokenStore, new SyncDescriptor(CopilotTokenStore));
	builder.define(IEnvService, new SyncDescriptor(NullEnvService));
	builder.define(IFetcherService, new SyncDescriptor(SingleFetcherService, [fetcher]));
	builder.define(ITelemetryService, new SyncDescriptor(SimpleTelemetryService, [telemetrySender]));
	builder.define(IAuthenticationService, new SyncDescriptor(StaticGitHubAuthenticationService, [createStaticGitHubTokenProvider()]));
	builder.define(ICopilotTokenManager, copilotTokenManager);
	builder.define(IChatMLFetcher, new SyncDescriptor(ChatMLFetcherImpl));
	builder.define(IChatQuotaService, new SyncDescriptor(ChatQuotaService));
	builder.define(IInteractionService, new SyncDescriptor(InteractionService));
	builder.define(IRequestLogger, new SyncDescriptor(NullRequestLogger));
	builder.define(ITokenizerProvider, new SyncDescriptor(TokenizerProvider, [false]));
	builder.define(IConversationOptions, {
		_serviceBrand: undefined,
		maxResponseTokens: undefined,
		temperature: 0.1,
		topP: 1,
		rejectionMessage: 'Sorry, but I can only assist with programming related questions.',
	});
	return builder.seal();
}

export class SimpleExperimentationService extends Disposable implements IExperimentationService {

	declare readonly _serviceBrand: undefined;

	private readonly variables: Record<string, boolean | number | string> = {};
	private readonly _onDidTreatmentsChange = this._register(new Emitter<TreatmentsChangeEvent>());
	readonly onDidTreatmentsChange = this._onDidTreatmentsChange.event;

	private readonly waitFor: Promise<void>;
	private readonly resolveWaitFor: () => void;

	constructor(
		waitForTreatmentVariables: boolean | undefined,
	) {
		super();
		if (waitForTreatmentVariables) {
			let resolveWaitFor: () => void;
			this.waitFor = new Promise<void>(resolve => {
				resolveWaitFor = resolve;
			});
			this.resolveWaitFor = resolveWaitFor!;
		} else {
			this.waitFor = Promise.resolve();
			this.resolveWaitFor = () => { };
		}
	}

	async hasTreatments(): Promise<void> {
		return this.waitFor;
	}

	getTreatmentVariable<T extends boolean | number | string>(name: string): T | undefined {
		return this.variables[name] as T | undefined;
	}

	async setCompletionsFilters(_filters: Map<string, string>): Promise<void> { }

	updateTreatmentVariables(variables: Record<string, boolean | number | string>): void {
		const changedVariables: string[] = [];
		for (const [key, value] of Object.entries(variables)) {
			const existing = this.variables[key];
			if (existing !== value) {
				this.variables[key] = value;
				changedVariables.push(key);
			}
		}
		for (const key of Object.keys(this.variables)) {
			if (!Object.hasOwn(variables, key)) {
				delete this.variables[key];
				changedVariables.push(key);
			}
		}
		if (changedVariables.length > 0) {
			this._onDidTreatmentsChange.fire({ affectedTreatmentVariables: changedVariables });
		}
		this.resolveWaitFor();
	}
}

class SingleFetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _fetcher: IFetcher,
	) { }

	getUserAgentLibrary(): string {
		return this._fetcher.getUserAgentLibrary();
	}

	fetch(url: string, options: FetchOptions) {
		return this._fetcher.fetch(url, options);
	}
	disconnectAll(): Promise<unknown> {
		return this._fetcher.disconnectAll();
	}
	makeAbortController(): IAbortController {
		return this._fetcher.makeAbortController();
	}
	isAbortError(e: any): boolean {
		return this._fetcher.isAbortError(e);
	}
	isInternetDisconnectedError(e: any): boolean {
		return this._fetcher.isInternetDisconnectedError(e);
	}
	isFetcherError(e: any): boolean {
		return this._fetcher.isFetcherError(e);
	}
	getUserMessageForFetcherError(err: any): string {
		return this._fetcher.getUserMessageForFetcherError(err);
	}
}

class SimpleTelemetryService implements ITelemetryService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly _telemetrySender: ITelemetrySender) { }

	dispose(): void {
		return;
	}

	sendInternalMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendMSFTTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		this._telemetrySender.sendTelemetryEvent(eventName, eventPropertiesToSimpleObject(properties), measurements);
	}
	sendGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendGHTelemetryException(maybeError: unknown, origin: string): void {
		return;
	}
	sendTelemetryEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendTelemetryErrorEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	setSharedProperty(name: string, value: string): void {
		return;
	}
	setAdditionalExpAssignments(expAssignments: string[]): void {
		return;
	}
	postEvent(eventName: string, props: Map<string, string>): void {
		return;
	}

	sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
	sendEnhancedGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties | undefined, measurements?: TelemetryEventMeasurements | undefined): void {
		return;
	}
}

export type IDocumentContext = DocumentContext;

export type CompletionsContextProviderMatchFunction = (documentSelector: DocumentSelector, documentContext: IDocumentContext) => Promise<number>;

export type ICompletionsStatusChangedEvent = StatusChangedEvent;

export interface ICompletionsStatusHandler {
	didChange(event: ICompletionsStatusChangedEvent): void;
}

export type ICompletionsTextDocumentChangeEvent = Event<TextDocumentChangeEvent>;
export type ICompletionsTextDocumentOpenEvent = Event<TextDocumentOpenEvent>;
export type ICompletionsTextDocumentCloseEvent = Event<TextDocumentCloseEvent>;
export type ICompletionsTextDocumentFocusedEvent = Event<TextDocumentFocusedEvent>;
export type ICompletionsWorkspaceFoldersChangeEvent = Event<WorkspaceFoldersChangeEvent>;
export type ICompletionsTextDocumentIdentifier = TextDocumentIdentifier;
export type ICompletionsNotebookDocument = INotebookDocument;
export type ICompletionsWorkspaceFolder = WorkspaceFolder;

export interface ICompletionsTextDocumentManager {
	onDidChangeTextDocument: ICompletionsTextDocumentChangeEvent;
	onDidOpenTextDocument: ICompletionsTextDocumentOpenEvent;
	onDidCloseTextDocument: ICompletionsTextDocumentCloseEvent;

	onDidFocusTextDocument: ICompletionsTextDocumentFocusedEvent;
	onDidChangeWorkspaceFolders: ICompletionsWorkspaceFoldersChangeEvent;

	/**
	 * Get all open text documents, skipping content exclusions and other validations.
	 */
	getTextDocumentsUnsafe(): ITextDocument[];

	/**
	 * If `TextDocument` represents notebook returns `INotebookDocument` instance, otherwise returns `undefined`
	 */
	findNotebook(doc: TextDocumentIdentifier): ICompletionsNotebookDocument | undefined;

	getWorkspaceFolders(): WorkspaceFolder[];
}

export interface IURLOpener {
	open(url: string): Promise<void>;
}

export type IEditorInfo = EditorInfo;
export type IEditorPluginInfo = EditorPluginInfo;

export interface IEditorSession {
	readonly sessionId: string;
	readonly machineId: string;
	readonly remoteName?: string;
	readonly uiKind?: string;
}

export type IActionItem = ActionItem
export interface INotificationSender {
	showWarningMessage(message: string, ...actions: IActionItem[]): Promise<IActionItem | undefined>;
}


export interface IInlineCompletionsProviderOptions {
	readonly fetcher: IFetcher;
	readonly authService: IAuthenticationService;
	readonly telemetrySender: ITelemetrySender;
	readonly logTarget?: ILogTarget;
	readonly isRunningInTest?: boolean;
	readonly contextProviderMatch: CompletionsContextProviderMatchFunction;
	readonly languageContextProvider?: ILanguageContextProviderService;
	readonly statusHandler: ICompletionsStatusHandler;
	readonly documentManager: ICompletionsTextDocumentManager;
	readonly workspace: ObservableWorkspace;
	readonly urlOpener: IURLOpener;
	readonly editorInfo: IEditorInfo;
	readonly editorPluginInfo: IEditorPluginInfo;
	readonly relatedPluginInfo: IEditorPluginInfo[];
	readonly editorSession: IEditorSession;
	readonly notificationSender: INotificationSender;
	readonly ignoreService?: IIgnoreService;
	readonly experimentationService?: IExperimentationService;
	readonly endpointProvider: IEndpointProvider;
	readonly capiClientService: ICAPIClientService;
}

export type IGetInlineCompletionsOptions = Exclude<Partial<GetGhostTextOptions>, 'promptOnly'> & {
	formattingOptions?: ITextEditorOptions;
};

export interface IInlineCompletionsProvider {
	getInlineCompletions(textDocument: ITextDocument, position: Position, token?: CancellationToken, options?: IGetInlineCompletionsOptions): Promise<CopilotCompletion[] | undefined>;
	dispose(): void;
}

export function createInlineCompletionsProvider(options: IInlineCompletionsProviderOptions): IInlineCompletionsProvider {
	const ctx = createContext(options);
	return new InlineCompletionsProvider(ctx);
}

class InlineCompletionsProvider extends Disposable implements IInlineCompletionsProvider {

	constructor(private _ctx: Context) {
		super();
	}

	async getInlineCompletions(textDocument: ITextDocument, position: Position, token?: CancellationToken, options?: IGetInlineCompletionsOptions): Promise<CopilotCompletion[] | undefined> {
		return await getInlineCompletions(this._ctx, textDocument, position, token, options);
	}
}

function createContext(options: IInlineCompletionsProviderOptions): Context {
	const { fetcher, authService, statusHandler, documentManager, workspace, telemetrySender, urlOpener, editorSession } = options;
	const logTarget = options.logTarget || new ConsoleLog(undefined, InternalLogLevel.Trace);

	const builder = new InstantiationServiceBuilder();
	builder.define(IAuthenticationService, authService);
	builder.define(IIgnoreService, options.ignoreService || new NullIgnoreService());
	builder.define(ITelemetryService, new SyncDescriptor(SimpleTelemetryService, [telemetrySender]));
	builder.define(IExperimentationService, options.experimentationService || new NullExperimentationService());
	builder.define(IEndpointProvider, options.endpointProvider);
	builder.define(ICAPIClientService, options.capiClientService);
	const instaService = builder.seal();

	const ctx = new Context();
	ctx.set(CompletionsIgnoreServiceBridge, instaService.createInstance(CompletionsIgnoreServiceBridge));
	ctx.set(CompletionsTelemetryServiceBridge, instaService.createInstance(CompletionsTelemetryServiceBridge));
	ctx.set(CompletionsAuthenticationServiceBridge, instaService.createInstance(CompletionsAuthenticationServiceBridge));
	ctx.set(CompletionsExperimentationServiceBridge, instaService.createInstance(CompletionsExperimentationServiceBridge));
	ctx.set(CompletionsEndpointProviderBridge, instaService.createInstance(CompletionsEndpointProviderBridge));
	ctx.set(CompletionsCapiBridge, instaService.createInstance(CompletionsCapiBridge));
	ctx.set(ConfigProvider, new InMemoryConfigProvider(new DefaultsOnlyConfigProvider(), new Map()));
	ctx.set(CopilotContentExclusionManager, new CopilotContentExclusionManager(ctx));
	ctx.set(RuntimeMode, RuntimeMode.fromEnvironment(options.isRunningInTest ?? false));
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
			return (fetcher as any).name || fetcher.constructor.name;
		}
		override fetch(url: string, options: FetchOptions) {
			return fetcher.fetch(url, options);
		}
		override disconnectAll(): Promise<unknown> {
			return fetcher.disconnectAll();
		}
	});

	ctx.set(NotificationSender, new class extends NotificationSender {
		async showWarningMessage(message: string, ...actions: IActionItem[]): Promise<IActionItem | undefined> {
			return await options.notificationSender.showWarningMessage(message, ...actions);
		}
	});
	ctx.set(EditorAndPluginInfo, new class extends EditorAndPluginInfo {
		override getEditorInfo(): EditorInfo {
			return options.editorInfo;
		}
		override getEditorPluginInfo(): EditorPluginInfo {
			return options.editorPluginInfo;
		}
		override getRelatedPluginInfo(): EditorPluginInfo[] {
			return options.relatedPluginInfo;
		}
	});
	ctx.set(EditorSession, new EditorSession(editorSession.sessionId, editorSession.machineId, editorSession.remoteName, editorSession.uiKind));
	ctx.set(CopilotExtensionStatus, new CopilotExtensionStatus());
	ctx.set(CopilotTokenManager, new CopilotTokenManager(ctx));
	ctx.set(StatusReporter, new class extends StatusReporter {
		didChange(event: StatusChangedEvent): void {
			statusHandler.didChange(event);
		}
	});
	ctx.set(TextDocumentManager, new class extends TextDocumentManager {
		onDidChangeTextDocument = documentManager.onDidChangeTextDocument;
		onDidOpenTextDocument = documentManager.onDidOpenTextDocument;
		onDidCloseTextDocument = documentManager.onDidCloseTextDocument;
		onDidFocusTextDocument = documentManager.onDidFocusTextDocument;
		onDidChangeWorkspaceFolders = documentManager.onDidChangeWorkspaceFolders;
		getTextDocumentsUnsafe(): ITextDocument[] {
			return documentManager.getTextDocumentsUnsafe();
		}
		findNotebook(doc: TextDocumentIdentifier): INotebookDocument | undefined {
			return documentManager.findNotebook(doc);
		}
		getWorkspaceFolders(): WorkspaceFolder[] {
			return documentManager.getWorkspaceFolders();
		}
	}(ctx));
	ctx.set(ObservableWorkspace, workspace);
	ctx.set(RecentEditsProvider, new FullRecentEditsProvider(ctx));
	ctx.set(FileSystem, new LocalFileSystem());
	ctx.set(RelatedFilesProvider, new CompositeRelatedFilesProvider(ctx));
	ctx.set(ContextProviderStatistics, new ContextProviderStatistics());
	ctx.set(ContextProviderRegistry, getContextProviderRegistry(
		ctx,
		(_, sel, docCtx) => options.contextProviderMatch(sel, docCtx),
		options.languageContextProvider ?? new NullLanguageContextProviderService()
	));
	ctx.set(ContextProviderBridge, new ContextProviderBridge(ctx));
	ctx.set(DefaultContextProviders, new DefaultContextProvidersContainer());
	ctx.set(ForceMultiLine, ForceMultiLine.default);
	ctx.set(UrlOpener, new class extends UrlOpener {
		async open(target: string) {
			await urlOpener.open(target);
		}
	});

	ctx.set(LogTarget, new class extends LogTarget {
		override logIt(ctx: Context, level: CompletionsLogLevel, category: string, ...extra: unknown[]): void {
			logTarget.logIt(this.toExternalLogLevel(level), category, ...extra);
		}
		toExternalLogLevel(level: CompletionsLogLevel): LogLevel {
			switch (level) {
				case CompletionsLogLevel.DEBUG: return LogLevel.Debug;
				case CompletionsLogLevel.INFO: return LogLevel.Info;
				case CompletionsLogLevel.WARN: return LogLevel.Warning;
				case CompletionsLogLevel.ERROR: return LogLevel.Error;
				default: return LogLevel.Info;
			}
		}
	});

	return ctx;
}
