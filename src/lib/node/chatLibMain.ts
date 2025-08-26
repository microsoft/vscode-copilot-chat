/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { DebugRecorder } from '../../extension/inlineEdits/node/debugRecorder';
import { NextEditProvider } from '../../extension/inlineEdits/node/nextEditProvider';
import { LlmNESTelemetryBuilder } from '../../extension/inlineEdits/node/nextEditProviderTelemetry';
import { INextEditResult } from '../../extension/inlineEdits/node/nextEditResult';
import { XtabProvider } from '../../extension/xtab/node/xtabProvider';
import { ConfigKey, IConfigurationService } from '../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../platform/configuration/common/defaultsOnlyConfigurationService';
import { IDiffService } from '../../platform/diff/common/diffService';
import { DiffServiceImpl } from '../../platform/diff/node/diffServiceImpl';
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
import { ISimulationTestContext, NulSimulationTestContext } from '../../platform/simulationTestContext/common/simulationTestContext';
import { ISnippyService, NullSnippyService } from '../../platform/snippy/common/snippyService';
import { IExperimentationService, NullExperimentationService } from '../../platform/telemetry/common/nullExperimentationService';
// import { TestWorkspaceService } from '../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../platform/workspace/common/workspaceService';
import { InstantiationServiceBuilder } from '../../util/common/services';
import { CancellationToken } from '../../util/vs/base/common/cancellation';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';



export function createNESProvider(workspace: ObservableWorkspace): INESProvider {
	const instantiationService = setupServices();
	return instantiationService.createInstance(NESProvider, workspace);
}

class NESProvider extends Disposable implements INESProvider {
	private readonly _nextEditProvider: NextEditProvider;
	private readonly _debugRecorder: DebugRecorder;

	constructor(
		private _workspace: ObservableWorkspace,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		const statelessNextEditProvider = instantiationService.createInstance(XtabProvider);
		const git = instantiationService.createInstance(ObservableGit);
		const historyContextProvider = new NesHistoryContextProvider(this._workspace, git);
		const xtabDiffNEntries = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffNEntries, this._expService);
		const xtabHistoryTracker = new NesXtabHistoryTracker(this._workspace, xtabDiffNEntries);
		this._debugRecorder = this._register(new DebugRecorder(this._workspace));

		this._nextEditProvider = instantiationService.createInstance(NextEditProvider, this._workspace, statelessNextEditProvider, historyContextProvider, xtabHistoryTracker, this._debugRecorder);
	}

	getId(): string {
		return this._nextEditProvider.ID;
	}

	async getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<INextEditResult> {
		const docId = DocumentId.create(documentUri.toString());

		// Create minimal required context objects
		const context: vscode.InlineCompletionContext = {
			triggerKind: 1, // Invoke
			selectedCompletionInfo: undefined,
			requestUuid: generateUuid(),
			requestIssuedDateTime: Date.now()
		};

		// Create log context
		const logContext = new InlineEditRequestLogContext(documentUri.toString(), 1, context);

		const document = this._workspace.getDocument(docId);
		if (!document) {
			throw new Error('DocumentNotFound');
		}

		// Create telemetry builder - we'll need to pass null/undefined for services we don't have
		const telemetryBuilder = new LlmNESTelemetryBuilder(
			new NullGitExtensionService(), // IGitExtensionService
			undefined, // INotebookService
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
	dispose(): void;
}

function setupServices() {
	const builder = new InstantiationServiceBuilder();
	builder.define(IConfigurationService, new SyncDescriptor(DefaultsOnlyConfigurationService));
	builder.define(IExperimentationService, new SyncDescriptor(NullExperimentationService));
	builder.define(ISimulationTestContext, new SyncDescriptor(NulSimulationTestContext));
	builder.define(IWorkspaceService, new SyncDescriptor(TestWorkspaceService));
	builder.define(IDiffService, new SyncDescriptor(DiffServiceImpl));
	builder.define(ILogService, new SyncDescriptor(LogServiceImpl, [[new ConsoleLog(undefined, LogLevel.Trace)]]));
	builder.define(IGitExtensionService, new SyncDescriptor(NullGitExtensionService));
	builder.define(ILanguageContextProviderService, new SyncDescriptor(NullLanguageContextProviderService));
	builder.define(ILanguageDiagnosticsService, new SyncDescriptor(TestLanguageDiagnosticsService));
	builder.define(IIgnoreService, new SyncDescriptor(NullIgnoreService));
	builder.define(ISnippyService, new SyncDescriptor(NullSnippyService));
	return builder.seal();
}
