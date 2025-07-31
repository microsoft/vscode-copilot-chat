/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, languages, window } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ObservableGit } from '../../../platform/inlineEdits/common/observableGit';
import { NesHistoryContextProvider } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { createTracer } from '../../../util/common/tracing';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, derived, derivedDisposable, observableFromEvent } from '../../../util/vs/base/common/observable';
import { join } from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { CompletionsProvider } from '../../completions/vscode-node/completionsProvider';
import { TelemetrySender } from '../node/nextEditProviderTelemetry';
import { InlineEditDebugComponent } from './components/inlineEditDebugComponent';
import { LogContextRecorder } from './components/logContextRecorder';
import { DiagnosticsNextEditProvider } from './features/diagnosticsInlineEditProvider';
import { InlineCompletionProviderImpl } from './inlineCompletionProvider';
import { InlineEditModel } from './inlineEditModel';
import { InlineEditLogger } from './parts/inlineEditLogger';
import { LastEditTimeTracker } from './parts/lastEditTimeTracker';
import { VSCodeWorkspace } from './parts/vscodeWorkspace';
import { makeSettable } from './utils/observablesUtils';

const TRIGGER_INLINE_EDIT_ON_ACTIVE_EDITOR_CHANGE = false; // otherwise, eg, NES would trigger just when going through search results

export class InlineEditProviderFeature extends Disposable implements IExtensionContribution {

	private readonly _inlineEditsProviderId = makeSettable(this._configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.InlineEditsProviderId, this._expService));

	private readonly _hideInternalInterface = this._configurationService.getConfigObservable(ConfigKey.Internal.InlineEditsHideInternalInterface);
	private readonly _enableDiagnosticsProvider = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.InlineEditsEnableDiagnosticsProvider, this._expService);
	private readonly _enableCompletionsProvider = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.InlineEditsEnableCompletionsProvider, this._expService);
	private readonly _yieldToCopilot = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.InlineEditsYieldToCopilot, this._expService);
	private readonly _copilotToken = observableFromEvent(this, this._authenticationService.onDidAuthenticationChange, () => this._authenticationService.copilotToken);

	public readonly inlineEditsEnabled = derived(this, (reader) => {
		const copilotToken = this._copilotToken.read(reader);
		if (copilotToken === undefined) {
			return false;
		}
		if (copilotToken.isCompletionsQuotaExceeded) {
			return false;
		}
		return true;
	});

	private readonly _internalActionsEnabled = derived(this, (reader) => {
		return !!this._copilotToken.read(reader)?.isInternal && !this._hideInternalInterface.read(reader);
	});

	public readonly inlineEditsLogFileEnabled = this._configurationService.getConfigObservable(ConfigKey.Internal.InlineEditsLogContextRecorderEnabled);

	private readonly _workspace = derivedDisposable(this, _reader => {
		return this._instantiationService.createInstance(VSCodeWorkspace);
	});

	constructor(
		@IVSCodeExtensionContext private readonly _vscodeExtensionContext: IVSCodeExtensionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IEnvService private readonly _envService: IEnvService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext
	) {
		super();

		const tracer = createTracer(['NES', 'Feature'], (s) => this._logService.trace(s));
		const constructorTracer = tracer.sub('constructor');

		const hasUpdatedNesSettingKey = 'copilot.chat.nextEdits.hasEnabledNesInSettings';
		this._register(autorun((reader) => {
			const copilotToken = this._copilotToken.read(reader);

			if (copilotToken === undefined) {
				return;
			}

			if (
				this._expService.getTreatmentVariable<boolean>('vscode', 'copilotchat.enableNesInSettings') &&
				this._extensionContext.globalState.get<boolean | undefined>(hasUpdatedNesSettingKey) !== true &&
				!copilotToken.isFreeUser
			) {
				this._extensionContext.globalState.update(hasUpdatedNesSettingKey, true);
				if (!this._configurationService.isConfigured(ConfigKey.InlineEditsEnabled)) {
					this._configurationService.setConfig(ConfigKey.InlineEditsEnabled, true);
				}
			}
		}));

		this._register(autorun(reader => {
			if (!this.inlineEditsEnabled.read(reader)) { return; }

			const logger = reader.store.add(this._instantiationService.createInstance(InlineEditLogger));

			const statelessProviderId = this._inlineEditsProviderId.read(reader);

			const workspace = this._workspace.read(reader);
			const git = reader.store.add(this._instantiationService.createInstance(ObservableGit));
			const historyContextProvider = new NesHistoryContextProvider(workspace, git);

			let diagnosticsProvider: DiagnosticsNextEditProvider | undefined = undefined;
			if (this._enableDiagnosticsProvider.read(reader)) {
				diagnosticsProvider = reader.store.add(this._instantiationService.createInstance(DiagnosticsNextEditProvider, workspace, git));
			}

			const completionsProvider = (this._enableCompletionsProvider.read(reader)
				? reader.store.add(this._instantiationService.createInstance(CompletionsProvider, workspace))
				: undefined);

			const model = reader.store.add(this._instantiationService.createInstance(InlineEditModel, statelessProviderId, workspace, historyContextProvider, diagnosticsProvider, completionsProvider));

			const recordingDirPath = join(this._vscodeExtensionContext.globalStorageUri.fsPath, 'logContextRecordings');
			const logContextRecorder = this.inlineEditsLogFileEnabled ? reader.store.add(this._instantiationService.createInstance(LogContextRecorder, recordingDirPath, logger)) : undefined;

			const inlineEditDebugComponent = reader.store.add(new InlineEditDebugComponent(this._internalActionsEnabled, this.inlineEditsEnabled, model.debugRecorder, this._inlineEditsProviderId));

			const telemetrySender = this._register(this._instantiationService.createInstance(TelemetrySender));

			const provider = this._instantiationService.createInstance(InlineCompletionProviderImpl, model, logger, logContextRecorder, inlineEditDebugComponent, telemetrySender);

			reader.store.add(languages.registerInlineCompletionItemProvider('*', provider, {
				displayName: provider.displayName,
				yieldTo: this._yieldToCopilot.read(reader) ? ['github.copilot'] : undefined,
			}));

			if (TRIGGER_INLINE_EDIT_ON_ACTIVE_EDITOR_CHANGE) {
				const lastEditTimeTracker = new LastEditTimeTracker(model.workspace);
				reader.store.add(window.onDidChangeActiveTextEditor((activeEditor) => {
					if (activeEditor !== undefined && lastEditTimeTracker.hadEditsRecently) {
						model.onChange.trigger(undefined);
					}
				}));
				reader.store.add(lastEditTimeTracker);
			}

			reader.store.add(commands.registerCommand(learnMoreCommandId, () => {
				this._envService.openExternal(URI.parse(learnMoreLink));
			}));

			reader.store.add(commands.registerCommand(clearCacheCommandId, () => {
				model.nextEditProvider.clearCache();
			}));
		}));

		constructorTracer.returns();
	}
}

export const learnMoreCommandId = 'github.copilot.debug.inlineEdit.learnMore';

export const learnMoreLink = 'https://aka.ms/vscode-nes';

const clearCacheCommandId = 'github.copilot.debug.inlineEdit.clearCache';
