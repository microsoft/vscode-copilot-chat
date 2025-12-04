/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'path';
import * as vscode from 'vscode';
import { IAuthenticationService, IExperimentationService } from '../../../lib/node/chatLibMain';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { JointCompletionsProviderStrategy } from '../../../platform/inlineEdits/common/dataTypes/jointCompletionsProviderOptions';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../../platform/inlineEdits/common/observableGit';
import { shortenOpportunityId } from '../../../platform/inlineEdits/common/utils/utils';
import { NesHistoryContextProvider } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { isNotebookCell } from '../../../util/common/notebooks';
import { createTracer, ITracer } from '../../../util/common/tracing';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { assertNever, softAssert } from '../../../util/vs/base/common/assert';
import { raceCancellation, timeout } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { autorun, derived, derivedDisposable, observableFromEvent } from '../../../util/vs/base/common/observable';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { URI } from '../../../util/vs/base/common/uri';
import { StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { Range } from '../../../util/vs/editor/common/core/range';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { createContext, registerUnificationCommands, setup } from '../../completions-core/vscode-node/completionsServiceBridges';
import { CopilotInlineCompletionItemProvider } from '../../completions-core/vscode-node/extension/src/inlineCompletion';
import { CompletionsCoreContribution } from '../../completions/vscode-node/completionsCoreContribution';
import { unificationStateObservable } from '../../completions/vscode-node/completionsUnificationContribution';
import { TelemetrySender } from '../node/nextEditProviderTelemetry';
import { InlineEditDebugComponent, reportFeedbackCommandId } from './components/inlineEditDebugComponent';
import { LogContextRecorder } from './components/logContextRecorder';
import { DiagnosticsNextEditProvider } from './features/diagnosticsInlineEditProvider';
import { InlineCompletionProviderImpl, NesCompletionItem, NesCompletionList } from './inlineCompletionProvider';
import { InlineEditModel } from './inlineEditModel';
import { clearCacheCommandId, InlineEditProviderFeature, InlineEditProviderFeatureContribution, learnMoreCommandId, learnMoreLink, reportNotebookNESIssueCommandId } from './inlineEditProviderFeature';
import { InlineEditLogger } from './parts/inlineEditLogger';
import { VSCodeWorkspace } from './parts/vscodeWorkspace';
import { makeSettable } from './utils/observablesUtils';

export class JointCompletionsProviderContribution extends Disposable implements IExtensionContribution {

	private readonly _inlineEditsProviderId = makeSettable(this._configurationService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsProviderId, this._expService));

	private readonly _hideInternalInterface = this._configurationService.getConfigObservable(ConfigKey.TeamInternal.InlineEditsHideInternalInterface);
	private readonly _enableDiagnosticsProvider = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.InlineEditsEnableDiagnosticsProvider, this._expService);
	// FIXME@ulugbekna: re-enable when yieldTo is supported
	// private readonly _yieldToCopilot = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsYieldToCopilot, this._expService);
	private readonly _excludedProviders = this._configurationService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsExcludedProviders, this._expService).map(v => v ? v.split(',').map(v => v.trim()).filter(v => v !== '') : []);
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

	public readonly isInlineEditsLogFileEnabledObservable = this._configurationService.getConfigObservable(ConfigKey.TeamInternal.InlineEditsLogContextRecorderEnabled);

	private readonly _workspace = derivedDisposable(this, _reader => {
		return this._instantiationService.createInstance(VSCodeWorkspace);
	});


	constructor(
		@IVSCodeExtensionContext private readonly _vscodeExtensionContext: IVSCodeExtensionContext,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEnvService private readonly _envService: IEnvService,
	) {
		super();

		const useJointCompletionsProviderObs = _configurationService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsJointCompletionsProviderEnabled, _expService);

		this._register(autorun((reader) => { // FX
			const useJointCompletionsProvider = useJointCompletionsProviderObs.read(reader);
			if (!useJointCompletionsProvider) {
				reader.store.add(_instantiationService.createInstance(InlineEditProviderFeatureContribution));
				reader.store.add(_instantiationService.createInstance(CompletionsCoreContribution));
				return;
			}

			const inlineEditFeature = _instantiationService.createInstance(InlineEditProviderFeature);
			reader.store.add(inlineEditFeature.rolloutFeature());
			inlineEditFeature.setContext();

			const unificationState = unificationStateObservable(this);

			reader.store.add(autorun((reader) => {
				const unificationStateValue = unificationState.read(reader);

				const excludes = this._excludedProviders.read(reader).slice();

				let inlineEditProvider: InlineCompletionProviderImpl | undefined = undefined;
				if (this.inlineEditsEnabled.read(reader)) {
					const logger = reader.store.add(this._instantiationService.createInstance(InlineEditLogger));

					const statelessProviderId = this._inlineEditsProviderId.read(reader);

					const workspace = this._workspace.read(reader);
					const git = reader.store.add(this._instantiationService.createInstance(ObservableGit));
					const historyContextProvider = new NesHistoryContextProvider(workspace, git);

					let diagnosticsProvider: DiagnosticsNextEditProvider | undefined = undefined;
					if (this._enableDiagnosticsProvider.read(reader)) {
						diagnosticsProvider = reader.store.add(this._instantiationService.createInstance(DiagnosticsNextEditProvider, workspace, git));
					}

					const model = reader.store.add(this._instantiationService.createInstance(InlineEditModel, statelessProviderId, workspace, historyContextProvider, diagnosticsProvider));

					const recordingDirPath = join(this._vscodeExtensionContext.globalStorageUri.fsPath, 'logContextRecordings');

					const isInlineEditLogFileEnabled = this.isInlineEditsLogFileEnabledObservable.read(reader);

					let logContextRecorder: LogContextRecorder | undefined;
					if (isInlineEditLogFileEnabled) {
						logContextRecorder = reader.store.add(this._instantiationService.createInstance(LogContextRecorder, recordingDirPath, logger));
					} else {
						void LogContextRecorder.cleanupOldRecordings(recordingDirPath);
					}

					const inlineEditDebugComponent = reader.store.add(new InlineEditDebugComponent(this._internalActionsEnabled, this.inlineEditsEnabled, model.debugRecorder, this._inlineEditsProviderId));

					const telemetrySender = reader.store.add(this._instantiationService.createInstance(TelemetrySender));

					inlineEditProvider = this._instantiationService.createInstance(InlineCompletionProviderImpl, model, logger, logContextRecorder, inlineEditDebugComponent, telemetrySender);

					reader.store.add(vscode.commands.registerCommand(learnMoreCommandId, () => {
						this._envService.openExternal(URI.parse(learnMoreLink));
					}));

					reader.store.add(vscode.commands.registerCommand(clearCacheCommandId, () => {
						model.nextEditProvider.clearCache();
					}));

					reader.store.add(vscode.commands.registerCommand(reportNotebookNESIssueCommandId, () => {
						const activeNotebook = vscode.window.activeNotebookEditor;
						const document = vscode.window.activeTextEditor?.document;
						if (!activeNotebook || !document || !isNotebookCell(document.uri)) {
							return;
						}
						const doc = model.workspace.getDocumentByTextDocument(document);
						const selection = activeNotebook.selection;
						if (!selection || !doc) {
							return;
						}

						const logContext = new InlineEditRequestLogContext(doc.id.uri, document.version, undefined);
						logContext.recordingBookmark = model.debugRecorder.createBookmark();
						void vscode.commands.executeCommand(reportFeedbackCommandId, { logContext });
					}));
				}

				let completionsProvider: CopilotInlineCompletionItemProvider | undefined;
				{
					const configEnabled = this._configurationService.getExperimentBasedConfigObservable<boolean>(ConfigKey.TeamInternal.InlineEditsEnableGhCompletionsProvider, this._expService).read(reader);
					const extensionUnification = unificationStateValue?.extensionUnification ?? false;

					// @ulugbekna: note that we don't want it if modelUnification is on
					const modelUnification = unificationStateValue?.modelUnification ?? false;
					if (!modelUnification || unificationStateValue?.codeUnification || extensionUnification || configEnabled || this._copilotToken.read(reader)?.isNoAuthUser) {
						completionsProvider = this._getOrCreateProvider();
					}

					void vscode.commands.executeCommand('setContext', 'github.copilot.extensionUnification.activated', extensionUnification);

					if (extensionUnification && this._completionsInstantiationService) {
						reader.store.add(this._completionsInstantiationService.invokeFunction(registerUnificationCommands));
					}
				}

				const singularProvider = this._instantiationService.createInstance(JointCompletionsProvider, completionsProvider, inlineEditProvider);

				if (unificationStateValue?.modelUnification) {
					if (!excludes.includes('github.copilot')) {
						excludes.push('github.copilot');
					}
				}

				reader.store.add(vscode.languages.registerInlineCompletionItemProvider(
					'*',
					singularProvider,
					{
						displayName: inlineEditProvider?.displayName,
						debounceDelayMs: 0, // set 0 debounce to ensure consistent delays/timings
						groupId: 'nes',
						excludes,
					})
				);

			}));
		}));
	}

	private _provider: CopilotInlineCompletionItemProvider | undefined;
	private _completionsInstantiationService: IInstantiationService | undefined;
	private _getOrCreateProvider() {
		if (!this._provider) {
			const disposables = this._register(new DisposableStore());
			this._completionsInstantiationService = this._instantiationService.invokeFunction(createContext, disposables);
			this._completionsInstantiationService.invokeFunction(setup, disposables);
			this._provider = disposables.add(this._completionsInstantiationService.createInstance(CopilotInlineCompletionItemProvider));
		}
		return this._provider;
	}

}

type SingularCompletionItem =
	| ({ source: 'completions' } & vscode.InlineCompletionItem)
	| ({ source: 'inlineEdits' } & NesCompletionItem)
	;

type SingularCompletionList =
	| ({ source: 'completions' } & vscode.InlineCompletionList)
	| ({ source: 'inlineEdits' } & NesCompletionList)
	;

function toCompletionsList(list: vscode.InlineCompletionList): SingularCompletionList {
	return { ...list, items: list.items.map(item => ({ ...item, source: 'completions' })), source: 'completions' };
}

function toInlineEditsList(list: NesCompletionList): SingularCompletionList {
	return { ...list, items: list.items.map(item => ({ ...item, source: 'inlineEdits' })), source: 'inlineEdits' };
}

class JointCompletionsProvider extends Disposable implements vscode.InlineCompletionItemProvider {

	public onDidChange?: vscode.Event<void> | undefined;

	constructor(
		private readonly _completionsProvider: CopilotInlineCompletionItemProvider | undefined,
		private readonly _inlineEditProvider: InlineCompletionProviderImpl | undefined,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.onDidChange = _inlineEditProvider?.onDidChange;
		softAssert(
			_completionsProvider?.onDidChange === undefined,
			'CompletionsProvider does not implement onDidChange'
		);
	}

	public async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<SingularCompletionList | undefined> {
		const tracer = createTracer(['JointCompletionsProvider', shortenOpportunityId(context.requestUuid), 'provideInlineCompletionItems'], (msg) => this._logService.trace(msg));

		const strategy = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsJointCompletionsProviderStrategy, this._expService);

		switch (strategy) {
			case JointCompletionsProviderStrategy.Regular:
				return this.provideInlineCompletionItemsRegular(document, position, context, token, tracer);
			default:
				assertNever(strategy);
		}
	}

	private lastNesSuggestion: null | { docUri: vscode.Uri; docWithNesEditApplied: StringText } = null;

	private async provideInlineCompletionItemsRegular(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken, tracer: ITracer): Promise<SingularCompletionList | undefined> {

		const completionsCts = new CancellationTokenSource(token);
		const nesCts = new CancellationTokenSource(token);

		try {
			const docSnapshot = new StringText(document.getText());
			const list = await this._provideInlineCompletionItemsRegular({ document, docSnapshot }, position, context, tracer, { coreToken: token, completionsCts, nesCts });

			// update last NES suggestion if the first item is a valid NES suggestion
			if (list?.source === 'inlineEdits' && list.items.length > 0 && list.items[0].range && typeof list.items[0].insertText === 'string') {
				tracer.trace(`updating last NES suggestion`);
				const range = list.items[0].range;
				const rangeOneBased = new Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
				const offsetRange = docSnapshot.getTransformer().getOffsetRange(rangeOneBased);
				const edit = new StringReplacement(offsetRange, list.items[0].insertText);
				const bigEdit = edit.toEdit();
				const applied = bigEdit.apply(docSnapshot.getValue());
				this.lastNesSuggestion = {
					docUri: document.uri,
					docWithNesEditApplied: new StringText(applied),
				};
			} else {
				tracer.trace(`clearing last NES suggestion`);
				this.lastNesSuggestion = null;
			}
			return list;
		} finally {
			completionsCts.dispose();
			nesCts.dispose();
		}
	}

	private async _provideInlineCompletionItemsRegular(
		{ document, docSnapshot }: { document: vscode.TextDocument; docSnapshot: StringText },
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		tracer: ITracer,
		tokens: { coreToken: CancellationToken; completionsCts: CancellationTokenSource; nesCts: CancellationTokenSource },
	): Promise<SingularCompletionList | undefined> {

		const sw = new StopWatch();

		if (this._completionsProvider === undefined && this._inlineEditProvider === undefined) {
			tracer.returns('neither completions nor NES provider available');
			return undefined;
		}

		tracer.trace('requesting completions');

		const completionsDelay = this._configService.getExperimentBasedConfig<number>(ConfigKey.TeamInternal.InlineEditsJointCompletionGhostTextDelayIfLastNes, this._expService);

		let completionsEndOfLifeReason: vscode.InlineCompletionsDisposeReason | undefined;
		let nesEndOfLifeReason: vscode.InlineCompletionsDisposeReason | undefined;

		let completionsP: Promise<vscode.InlineCompletionList | undefined> | undefined;
		if (this._completionsProvider === undefined) {
			tracer.trace(`- no completions provider`);
			completionsP = undefined;
		} else {
			tracer.trace(`- requesting completions provideInlineCompletionItems`);
			completionsP = this._completionsProvider.provideInlineCompletionItems(document, position, context, tokens.completionsCts.token).then(v => {
				if (v === undefined) {
					return undefined;
				}
				if (completionsEndOfLifeReason === undefined) {
					return v;
				}
				// completions was picked over NES, mark completions items as ignored
				for (const item of v.items) {
					this._completionsProvider?.handleEndOfLifetime?.(item as vscode.InlineCompletionItem, { kind: vscode.InlineCompletionEndOfLifeReasonKind.Ignored, userTypingDisagreed: false });
				}
				this._completionsProvider?.handleListEndOfLifetime?.(v!, completionsEndOfLifeReason);
				return undefined;
			});
		}

		let nesP: Promise<NesCompletionList | undefined> | undefined;
		if (this._inlineEditProvider === undefined) {
			tracer.trace(`- no NES provider`);
			nesP = undefined;
		} else {
			tracer.trace(`- requesting NES provideInlineCompletionItems`);
			nesP = this._inlineEditProvider.provideInlineCompletionItems(document, position, context, tokens.nesCts.token).then(v => {
				if (v === undefined) {
					return undefined;
				}
				if (nesEndOfLifeReason === undefined) {
					return v;
				}
				// completions was picked over NES, mark NES items as ignored
				for (const item of v.items) {
					this._inlineEditProvider?.handleEndOfLifetime?.(item as NesCompletionItem, { kind: vscode.InlineCompletionEndOfLifeReasonKind.Ignored, userTypingDisagreed: false });
				}
				this._inlineEditProvider?.handleListEndOfLifetime?.(v!, nesEndOfLifeReason);
				return undefined;
			});
		}

		if (this.lastNesSuggestion) {
			if (this.lastNesSuggestion.docUri.toString() !== document.uri.toString()) {
				tracer.trace('last NES suggestion is not for the current document, ignoring');
				this.lastNesSuggestion = null;
			} else {
				tracer.trace(`last NES suggestion is for the current document, checking if it agrees with the current suggestion`);
				const providerCallSw = new StopWatch();
				const suggestionsList = await raceCancellation(Promise.race(coalesce([
					completionsP?.then(async res => {
						const delayFor = Math.max(0, completionsDelay - providerCallSw.elapsed());
						if (delayFor > 0 && !tokens.completionsCts.token.isCancellationRequested) {
							tracer.trace(`delaying completions response by ${delayFor}ms because last suggestion was NES`);
							await timeout(delayFor);
						}
						return { type: 'completions' as const, res };
					}),
					nesP?.then(res => ({ type: 'nes' as const, res })),
				])), tokens.coreToken);

				// got cancelled
				if (suggestionsList === undefined) {
					tracer.trace(`suggestions request was cancelled`);
					completionsEndOfLifeReason = { kind: vscode.InlineCompletionsDisposeReasonKind.TokenCancellation };
					nesEndOfLifeReason = { kind: vscode.InlineCompletionsDisposeReasonKind.TokenCancellation };
					tokens.completionsCts.cancel();
					tokens.nesCts.cancel();
					return undefined;
				}

				// got nes
				if (suggestionsList.type === 'nes' && suggestionsList.res !== undefined && this.doesNesSuggestionAgree(docSnapshot, this.lastNesSuggestion.docWithNesEditApplied, (suggestionsList.res.items as NesCompletionItem[]).at(0))) {
					tracer.trace('last NES suggestion agrees with the current suggestion, using NES');
					// cancel completions
					completionsEndOfLifeReason = { kind: vscode.InlineCompletionsDisposeReasonKind.NotTaken };
					tokens.completionsCts.cancel();
					return toInlineEditsList(suggestionsList.res!);
				} else {
					tracer.trace('last NES suggestion does not agree with the current suggestion, ignoring last NES suggestion');
					this.lastNesSuggestion = null;
				}
			}
		}

		tracer.trace(`waiting for completions response`);

		const completionsR = completionsP ? await completionsP : undefined;
		tracer.trace(`got completions response in ${sw.elapsed()}ms -- ${completionsR === undefined ? 'undefined' : `with ${completionsR.items.length} items`}`);

		if (completionsR) {
			if (completionsR.items.length === 0) {
				completionsEndOfLifeReason = { kind: vscode.InlineCompletionsDisposeReasonKind.NotTaken };
			} else {
				tracer.trace(`using completions response, cancelling NES provider`);
				tokens.nesCts.cancel(); // cancel NES request if completions are available
				const list: SingularCompletionList = toCompletionsList(completionsR);
				tracer.returns(`use completions response in ${sw.elapsed()}ms`);

				nesEndOfLifeReason = { kind: vscode.InlineCompletionsDisposeReasonKind.LostRace };

				return list;
			}
		}

		const nesR = nesP ? await nesP : undefined;
		tracer.trace(`got NES response in ${sw.elapsed()}ms -- ${nesR === undefined ? 'undefined' : `with ${nesR.items.length} items`}`);

		if (nesR && nesR.items.length > 0) {
			const list: SingularCompletionList = toInlineEditsList(nesR);
			tracer.returns(`returning NES result in ${sw.elapsed()}ms`);
			return list;
		}

		// return completions if any (could be empty), prefer completions over empty NES
		const list: SingularCompletionList = toCompletionsList(completionsR ?? { items: [] });
		tracer.returns(`returning completions (possibly empty) in ${sw.elapsed()}ms`);
		return list;
	}

	private doesNesSuggestionAgree(doc: StringText, docWithNesEditApplied: StringText, nesEdit: NesCompletionItem | undefined): boolean {
		if (nesEdit === undefined || nesEdit.range === undefined || typeof nesEdit.insertText !== 'string') {
			return false;
		}
		const range = nesEdit.range;
		const rangeOneBased = new Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
		const offsetRange = doc.getTransformer().getOffsetRange(rangeOneBased);
		const edit = new StringReplacement(offsetRange, nesEdit.insertText);
		const bigEdit = edit.toEdit();
		return bigEdit.apply(doc.getValue()) === docWithNesEditApplied.getValue();
	}

	public handleDidShowCompletionItem?(completionItem: SingularCompletionItem, updatedInsertText: string): void {
		switch (completionItem.source) {
			case 'completions':
				this._completionsProvider?.handleDidShowCompletionItem?.(completionItem, updatedInsertText);
				break;
			case 'inlineEdits':
				this._inlineEditProvider?.handleDidShowCompletionItem?.(completionItem, updatedInsertText);
				break;
			default:
				assertNever(completionItem);
		}
	}

	public handleDidPartiallyAcceptCompletionItem?(completionItem: SingularCompletionItem, acceptedLength: number & vscode.PartialAcceptInfo): void {
		switch (completionItem.source) {
			case 'completions':
				this._completionsProvider?.handleDidPartiallyAcceptCompletionItem?.(completionItem, acceptedLength);
				break;
			case 'inlineEdits':
				softAssert(this._inlineEditProvider?.handleDidPartiallyAcceptCompletionItem === undefined, 'InlineEditProvider does not implement handleDidPartiallyAcceptCompletionItem');
				break;
			default:
				assertNever(completionItem);
		}
	}

	public handleEndOfLifetime?(completionItem: SingularCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
		switch (completionItem.source) {
			case 'completions':
				this._completionsProvider?.handleEndOfLifetime?.(completionItem, reason);
				break;
			case 'inlineEdits':
				this._inlineEditProvider?.handleEndOfLifetime?.(completionItem, reason);
				break;
			default:
				assertNever(completionItem);
		}
	}

	public handleListEndOfLifetime?(list: SingularCompletionList, reason: vscode.InlineCompletionsDisposeReason): void {
		switch (list.source) {
			case 'completions':
				softAssert(this._completionsProvider?.handleListEndOfLifetime === undefined, 'CompletionsProvider does not implement handleListEndOfLifetime');
				break;
			case 'inlineEdits':
				this._inlineEditProvider?.handleListEndOfLifetime?.(list, reason);
				break;
			default:
				assertNever(list);
		}
	}

	// neither provider implements this deprecated method
	public handleDidRejectCompletionItem = undefined;
}

