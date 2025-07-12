/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugRecorder } from '../../extension/inlineEdits/node/debugRecorder';
import { NextEditProvider } from '../../extension/inlineEdits/node/nextEditProvider';
import { XtabProvider } from '../../extension/xtab/node/xtabProvider';
import { ConfigKey, IConfigurationService } from '../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../platform/configuration/common/defaultsOnlyConfigurationService';
import { ObservableGit } from '../../platform/inlineEdits/common/observableGit';
import { MutableObservableWorkspace } from '../../platform/inlineEdits/common/observableWorkspace';
import { NesHistoryContextProvider } from '../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { IExperimentationService } from '../../platform/telemetry/common/nullExperimentationService';
import { InstantiationServiceBuilder } from '../../util/common/services';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';

export interface ICreationOptions {
}

export function createFacade(): INESFacade {
	const instantiationService = setupServices();
	return instantiationService.createInstance(NESFacade);
}

class NESFacade extends Disposable implements INESFacade {
	private readonly _nextEditProvider: NextEditProvider;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		const workspace = new MutableObservableWorkspace();
		const statelessNextEditProvider = instantiationService.createInstance(XtabProvider);
		const git = instantiationService.createInstance(ObservableGit);
		const historyContextProvider = new NesHistoryContextProvider(workspace, git);
		const xtabDiffNEntries = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffNEntries, this._expService);
		const xtabHistoryTracker = new NesXtabHistoryTracker(workspace, xtabDiffNEntries);
		const debugRecorder = this._register(new DebugRecorder(workspace));

		this._nextEditProvider = instantiationService.createInstance(NextEditProvider, workspace, statelessNextEditProvider, historyContextProvider, xtabHistoryTracker, debugRecorder);
	}

	getId(): string {
		return this._nextEditProvider.ID;
	}
}

export interface INESFacade {
	getId(): string;
}

function setupServices() {
	const b = new InstantiationServiceBuilder();
	b.define(IConfigurationService, new SyncDescriptor(DefaultsOnlyConfigurationService));
	return b.seal();
}
