/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { DebugRecorder } from '../../extension/inlineEdits/node/debugRecorder';
import { INextEditProvider, NextEditProvider } from '../../extension/inlineEdits/node/nextEditProvider';
import { LlmNESTelemetryBuilder } from '../../extension/inlineEdits/node/nextEditProviderTelemetry';
import { INextEditResult } from '../../extension/inlineEdits/node/nextEditResult';
import { ChatMLFetcherImpl } from '../../extension/prompt/node/chatMLFetcher';
import { XtabProvider } from '../../extension/xtab/node/xtabProvider';
import { IAuthenticationService } from '../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../platform/authentication/common/copilotTokenManager';
import { CopilotTokenStore, ICopilotTokenStore } from '../../platform/authentication/common/copilotTokenStore';
import { StaticGitHubAuthenticationService } from '../../platform/authentication/common/staticGitHubAuthenticationService';
import { getStaticGitHubToken } from '../../platform/authentication/node/copilotTokenManager';
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
import { ConsoleLog, ILogService, LogLevel, LogServiceImpl } from '../../platform/log/common/logService';
import { FetchOptions, IAbortController, IFetcherService } from '../../platform/networking/common/fetcherService';
import { IFetcher } from '../../platform/networking/common/networking';
import { NullRequestLogger } from '../../platform/requestLogger/node/nullRequestLogger';
import { IRequestLogger } from '../../platform/requestLogger/node/requestLogger';
import { ISimulationTestContext, NulSimulationTestContext } from '../../platform/simulationTestContext/common/simulationTestContext';
import { ISnippyService, NullSnippyService } from '../../platform/snippy/common/snippyService';
import { IExperimentationService, NullExperimentationService } from '../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryDestination, TelemetryEventMeasurements, TelemetryEventProperties } from '../../platform/telemetry/common/telemetry';
import { ITokenizerProvider, TokenizerProvider } from '../../platform/tokenizer/node/tokenizer';
import { IWorkspaceService, NullWorkspaceService } from '../../platform/workspace/common/workspaceService';
import { InstantiationServiceBuilder } from '../../util/common/services';
import { CancellationToken } from '../../util/vs/base/common/cancellation';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';
import { eventPropertiesToSimpleObject } from '../../platform/telemetry/common/telemetryData';

export interface ITelemetrySender {
	sendTelemetryEvent(eventName: string, properties?: Record<string, string | undefined>, measurements?: Record<string, number | undefined>): void;
}

export interface INESProviderOptions {
	readonly workspace: ObservableWorkspace;
	readonly fetcher: IFetcher;
	readonly copilotTokenManager: ICopilotTokenManager;
	readonly telemetrySender: ITelemetrySender;
}

export function createNESProvider(options: INESProviderOptions): INESProvider {
	const instantiationService = setupServices(options);
	return instantiationService.createInstance(NESProvider, options);
}

class NESProvider extends Disposable implements INESProvider {
	private readonly _nextEditProvider: INextEditProvider<INextEditResult, LlmNESTelemetryBuilder>;
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
		const xtabDiffNEntries = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffNEntries, this._expService);
		const xtabHistoryTracker = new NesXtabHistoryTracker(this._options.workspace, xtabDiffNEntries);
		this._debugRecorder = this._register(new DebugRecorder(this._options.workspace));

		this._nextEditProvider = instantiationService.createInstance(NextEditProvider, this._options.workspace, statelessNextEditProvider, historyContextProvider, xtabHistoryTracker, this._debugRecorder);
	}

	getId(): string {
		return this._nextEditProvider.ID;
	}

	handleShown(suggestion: INextEditResult): void {
		this._nextEditProvider.handleShown(suggestion);
	}

	handleAcceptance(docId: DocumentId, suggestion: INextEditResult): void {
		this._nextEditProvider.handleAcceptance(docId, suggestion);
	}

	handleRejection(docId: DocumentId, suggestion: INextEditResult): void {
		this._nextEditProvider.handleRejection(docId, suggestion);
	}

	handleIgnored(docId: DocumentId, suggestion: INextEditResult, supersededByRequestUuid: INextEditResult | undefined): void {
		this._nextEditProvider.handleIgnored(docId, suggestion, supersededByRequestUuid);
	}

	async getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<INextEditResult> {
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
		const telemetryBuilder = new LlmNESTelemetryBuilder(
			new NullGitExtensionService(), // IGitExtensionService
			undefined, // INotebookService
			this._workspaceService, // IWorkspaceService
			this._nextEditProvider.ID, // providerId
			document, // doc
			this._debugRecorder, // debugRecorder
			undefined // requestBookmark
		);

		return await this._nextEditProvider.getNextEdit(docId, context, logContext, cancellationToken, telemetryBuilder);
	}
}

export interface INESProvider {
	getId(): string;
	getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<INextEditResult>;
	handleShown(suggestion: INextEditResult): void;
	handleAcceptance(docId: DocumentId, suggestion: INextEditResult): void;
	handleRejection(docId: DocumentId, suggestion: INextEditResult): void;
	handleIgnored(docId: DocumentId, suggestion: INextEditResult, supersededByRequestUuid: INextEditResult | undefined): void;
	dispose(): void;
}

function setupServices(options: INESProviderOptions) {
	const { fetcher, copilotTokenManager, telemetrySender } = options;
	const builder = new InstantiationServiceBuilder();
	builder.define(IConfigurationService, new SyncDescriptor(DefaultsOnlyConfigurationService));
	builder.define(IExperimentationService, new SyncDescriptor(NullExperimentationService));
	builder.define(ISimulationTestContext, new SyncDescriptor(NulSimulationTestContext));
	builder.define(IWorkspaceService, new SyncDescriptor(NullWorkspaceService));
	builder.define(IDiffService, new SyncDescriptor(DiffServiceImpl, [false]));
	builder.define(ILogService, new SyncDescriptor(LogServiceImpl, [[new ConsoleLog(undefined, LogLevel.Trace)]]));
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
	builder.define(IAuthenticationService, new SyncDescriptor(StaticGitHubAuthenticationService, [getStaticGitHubToken]));
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
