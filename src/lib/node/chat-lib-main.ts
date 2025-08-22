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
import { NullGitExtensionService } from '../../platform/git/common/nullGitExtensionService';
import { DocumentId } from '../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../platform/inlineEdits/common/observableGit';
import { MutableObservableWorkspace } from '../../platform/inlineEdits/common/observableWorkspace';
import { NesHistoryContextProvider } from '../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { IExperimentationService } from '../../platform/telemetry/common/nullExperimentationService';
import { InstantiationServiceBuilder } from '../../util/common/services';
import { CancellationToken } from '../../util/vs/base/common/cancellation';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';

export function createNESProvider(): INESProvider {
	const instantiationService = setupServices();
	return instantiationService.createInstance(NESProvider);
}

class NESProvider extends Disposable implements INESProvider {
	private readonly _nextEditProvider: NextEditProvider;
	private readonly _workspace: MutableObservableWorkspace;
	private readonly _debugRecorder: DebugRecorder;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._workspace = new MutableObservableWorkspace();
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

		// Create telemetry builder - we'll need to pass null/undefined for services we don't have
		const telemetryBuilder = new LlmNESTelemetryBuilder(
			new NullGitExtensionService(), // IGitExtensionService
			undefined, // INotebookService
			this._nextEditProvider.ID, // providerId
			this._workspace.getDocument(docId) || this._workspace.addDocument({ id: docId }), // doc
			this._debugRecorder, // debugRecorder
			undefined // requestBookmark
		);

		return await this._nextEditProvider.getNextEdit(docId, context, logContext, cancellationToken, telemetryBuilder);
	}
}

export interface INESProvider {
	getId(): string;
	getNextEdit(documentUri: vscode.Uri, cancellationToken: CancellationToken): Promise<INextEditResult>;
}

function setupServices() {
	const b = new InstantiationServiceBuilder();
	b.define(IConfigurationService, new SyncDescriptor(DefaultsOnlyConfigurationService));
	return b.seal();
}
