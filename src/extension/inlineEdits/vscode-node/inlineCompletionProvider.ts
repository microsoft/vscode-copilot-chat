/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Command, InlineCompletionContext, InlineCompletionDisplayLocation, InlineCompletionEndOfLifeReason, InlineCompletionEndOfLifeReasonKind, InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionList, InlineCompletionsDisposeReason, InlineCompletionsDisposeReasonKind, Position, Range, TextDocument, l10n, Event as vscodeEvent } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDiffService } from '../../../platform/diff/common/diffService';
import { stringEditFromDiff } from '../../../platform/editing/common/edit';
import { DocumentEditRecorder } from '../../../platform/editSurvivalTracking/common/editComputer';
import { EditSurvivalReporter } from '../../../platform/editSurvivalTracking/common/editSurvivalReporter';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { ShowNextEditPreference } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITracer, createTracer } from '../../../util/common/tracing';
import { softAssert } from '../../../util/vs/base/common/assert';
import { raceCancellation, timeout } from '../../../util/vs/base/common/async';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { StringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LineCheck } from '../../inlineChat/vscode-node/inlineChatHint';
import { NextEditProviderTelemetryBuilder, TelemetrySender } from '../node/nextEditProviderTelemetry';
import { INextEditResult, NextEditResult } from '../node/nextEditResult';
import { InlineCompletionCommand, InlineEditDebugComponent } from './components/inlineEditDebugComponent';
import { LogContextRecorder } from './components/logContextRecorder';
import { toExternalRange } from './features/diagnosticsBasedCompletions/diagnosticsCompletions';
import { DiagnosticsNextEditResult } from './features/diagnosticsInlineEditProvider';
import { InlineEditModel } from './inlineEditModel';
import { learnMoreCommandId, learnMoreLink } from './inlineEditProviderFeature';
import { isInlineSuggestion } from './isInlineSuggestion';
import { InlineEditLogger } from './parts/inlineEditLogger';
import { INotebookService } from '../../../platform/notebook/common/notebookService';

export interface NesCompletionItem extends InlineCompletionItem {
	readonly telemetryBuilder: NextEditProviderTelemetryBuilder;
	readonly info: NesCompletionInfo;
	wasShown: boolean;
}

class NesCompletionList extends InlineCompletionList {

	public override enableForwardStability = true;

	constructor(
		public readonly requestUuid: string,
		item: NesCompletionItem | undefined,
		public override readonly commands: InlineCompletionCommand[],
		public readonly telemetryBuilder: NextEditProviderTelemetryBuilder,
	) {
		super(item === undefined ? [] : [item]);
	}
}

abstract class BaseNesCompletionInfo<T extends INextEditResult> {

	public abstract source: string;

	constructor(
		public readonly suggestion: T,
		public readonly documentId: DocumentId,
		public readonly document: TextDocument,
		public readonly requestUuid: string
	) { }
}

class LlmCompletionInfo extends BaseNesCompletionInfo<NextEditResult> {
	public readonly source = 'provider';
}

class DiagnosticsCompletionInfo extends BaseNesCompletionInfo<DiagnosticsNextEditResult> {
	public readonly source = 'diagnostics';
}

type NesCompletionInfo = LlmCompletionInfo | DiagnosticsCompletionInfo;

function isLlmCompletionInfo(item: NesCompletionInfo): item is LlmCompletionInfo {
	return item.source === 'provider';
}


export class InlineCompletionProviderImpl implements InlineCompletionItemProvider {
	public readonly displayName = 'Next edit suggestion';

	private readonly _tracer: ITracer;

	public readonly onDidChange: vscodeEvent<void> | undefined = Event.fromObservableLight(this.model.onChange);

	constructor(
		private readonly model: InlineEditModel,
		private readonly logger: InlineEditLogger,
		private readonly logContextRecorder: LogContextRecorder | undefined,
		private readonly inlineEditDebugComponent: InlineEditDebugComponent | undefined,
		private readonly telemetrySender: TelemetrySender,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IDiffService private readonly _diffService: IDiffService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
		@INotebookService private readonly _notebookService: INotebookService,
	) {
		this._tracer = createTracer(['NES', 'Provider'], (s) => this._logService.trace(s));
	}

	// copied from `vscodeWorkspace.ts` `DocumentFilter#_enabledLanguages`
	private _isCompletionsEnabled(document: TextDocument): boolean {
		const enabledLanguages = this._configurationService.getConfig(ConfigKey.Shared.Enable);
		const enabledLanguagesMap = new Map(Object.entries(enabledLanguages));
		if (!enabledLanguagesMap.has('*')) {
			enabledLanguagesMap.set('*', false);
		}
		return enabledLanguagesMap.has(document.languageId) ? enabledLanguagesMap.get(document.languageId)! : enabledLanguagesMap.get('*')!;
	}

	public async provideInlineCompletionItems(
		document: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<NesCompletionList | undefined> {
		const tracer = this._tracer.sub(['provideInlineCompletionItems', shortOpportunityId(context.requestUuid)]);

		const isCompletionsEnabled = this._isCompletionsEnabled(document);

		const unification = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsUnification, this._expService);

		const isInlineEditsEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.InlineEditsEnabled, this._expService, { languageId: document.languageId });

		const serveAsCompletionsProvider = unification && isCompletionsEnabled && !isInlineEditsEnabled;

		if (!isInlineEditsEnabled && !serveAsCompletionsProvider) {
			tracer.returns('inline edits disabled');
			return undefined;
		}

		const doc = this.model.workspace.getDocumentByTextDocument(document);
		if (!doc) {
			tracer.returns('document not found in workspace');
			return undefined;
		}

		const logContext = new InlineEditRequestLogContext(doc.id.uri, document.version, context);
		logContext.recordingBookmark = this.model.debugRecorder.createBookmark();

		const telemetryBuilder = new NextEditProviderTelemetryBuilder(this._gitExtensionService, this._notebookService, this.model.nextEditProvider.ID, doc, this.model.debugRecorder, logContext.recordingBookmark);
		telemetryBuilder.setOpportunityId(context.requestUuid);
		telemetryBuilder.setConfigIsDiagnosticsNESEnabled(!!this.model.diagnosticsBasedProvider);
		telemetryBuilder.setIsNaturalLanguageDominated(LineCheck.isNaturalLanguageDominated(document, position));

		const requestCancellationTokenSource = new CancellationTokenSource(token);
		const completionsCts = new CancellationTokenSource(token);
		let suggestionInfo: NesCompletionInfo | undefined;
		try {
			tracer.trace('invoking next edit provider');

			const { first, all } = raceAndAll([
				this.model.nextEditProvider.getNextEdit(doc.id, context, logContext, token, telemetryBuilder.nesBuilder),
				this.model.diagnosticsBasedProvider?.runUntilNextEdit(doc.id, context, logContext, 50, requestCancellationTokenSource.token, telemetryBuilder.diagnosticsBuilder) ?? raceCancellation(new Promise<undefined>(() => { }), requestCancellationTokenSource.token),
				this.model.completionsProvider?.getCompletions(doc.id, context, logContext, token) ?? raceCancellation(new Promise<undefined>(() => { }), completionsCts.token),
			]);

			let [providerSuggestion, diagnosticsSuggestion, completionAtCursor] = await first;

			// ensure completions promise resolves
			completionsCts.cancel();

			const hasCompletionAtCursor = completionAtCursor && completionAtCursor.result !== undefined;
			const hasNonEmptyLlmNes = providerSuggestion && providerSuggestion.result !== undefined;

			const shouldGiveMoreTimeToDiagnostics = !hasCompletionAtCursor && !hasNonEmptyLlmNes && this.model.diagnosticsBasedProvider;

			if (shouldGiveMoreTimeToDiagnostics) {
				tracer.trace('giving some more time to diagnostics provider');
				timeout(1000).then(() => requestCancellationTokenSource.cancel());
				[, diagnosticsSuggestion] = await all;
			}

			// Cancel ongoing requests
			requestCancellationTokenSource.cancel();

			const emptyList = new NesCompletionList(context.requestUuid, undefined, [], telemetryBuilder);

			if (token.isCancellationRequested) {
				tracer.returns('lost race to cancellation');
				this.telemetrySender.scheduleSendingEnhancedTelemetry({ requestId: logContext.requestId, result: undefined }, telemetryBuilder);
				return emptyList;
			}

			// Determine which suggestion to use
			if (completionAtCursor?.result) {
				suggestionInfo = new LlmCompletionInfo(completionAtCursor, doc.id, document, context.requestUuid);
			} else if (diagnosticsSuggestion?.result) {
				suggestionInfo = new DiagnosticsCompletionInfo(diagnosticsSuggestion, doc.id, document, context.requestUuid);
			} else if (providerSuggestion) {
				suggestionInfo = new LlmCompletionInfo(providerSuggestion, doc.id, document, context.requestUuid);
			} else {
				this.telemetrySender.scheduleSendingEnhancedTelemetry({ requestId: logContext.requestId, result: undefined }, telemetryBuilder);
				return emptyList;
			}

			// Return and send telemetry if there is no result
			const result = suggestionInfo.suggestion.result;
			if (!result) {
				tracer.trace('no next edit suggestion');
				this.telemetrySender.scheduleSendingEnhancedTelemetry(suggestionInfo.suggestion, telemetryBuilder);
				return emptyList;
			}

			tracer.trace(`using next edit suggestion from ${suggestionInfo.source}`);

			const range = doc.fromOffsetRange(document, result.edit.replaceRange);
			if (!range) {
				tracer.trace('no next edit suggestion for notebook cell');
				this.telemetrySender.scheduleSendingEnhancedTelemetry(suggestionInfo.suggestion, telemetryBuilder);
				return emptyList;
			}

			// Only show edit when the cursor is max 4 lines away from the edit
			const showRange = (
				result.showRangePreference === ShowNextEditPreference.AroundEdit
					? new Range(
						Math.max(range.start.line - 4, 0),
						0,
						range.end.line + 4,
						Number.MAX_SAFE_INTEGER
					)
					: undefined
			);

			const displayRange = result.displayLocation ? doc.fromRange(document, toExternalRange(result.displayLocation.range)) : undefined;
			const displayLocation: InlineCompletionDisplayLocation | undefined = result.displayLocation && displayRange ? {
				range: displayRange,
				label: result.displayLocation.label
			} : undefined;

			const learnMoreAction: Command = {
				title: l10n.t('Learn More'),
				command: learnMoreCommandId,
				tooltip: learnMoreLink
			};

			const menuCommands: InlineCompletionCommand[] = [];
			if (this.inlineEditDebugComponent) {
				menuCommands.push(...this.inlineEditDebugComponent.getCommands(logContext));
			}

			const allowInlineCompletions = this.model.inlineEditsInlineCompletionsEnabled.get();
			const isInlineCompletion = allowInlineCompletions && isInlineSuggestion(position, document, range, result.edit.newText);

			if (serveAsCompletionsProvider && !isInlineCompletion) {
				this.telemetrySender.scheduleSendingEnhancedTelemetry(suggestionInfo.suggestion, telemetryBuilder);
				return emptyList;
			}

			const inlineEdit: NesCompletionItem = {
				range,
				insertText: result.edit.newText,
				showRange,
				action: learnMoreAction,
				info: suggestionInfo,
				isInlineEdit: !isInlineCompletion,
				showInlineEditMenu: !serveAsCompletionsProvider,
				displayLocation,
				telemetryBuilder,
				wasShown: false,
			};

			// telemetry
			telemetryBuilder.setPickedNESType(suggestionInfo.source === 'diagnostics' ? 'diagnostics' : 'llm');
			logContext.setPickedNESType(suggestionInfo.source === 'diagnostics' ? 'diagnostics' : 'llm');
			telemetryBuilder.setPostProcessingOutcome({ edit: result.edit, displayLocation: result.displayLocation, isInlineCompletion });
			telemetryBuilder.setHadLlmNES(suggestionInfo.source === 'provider');
			telemetryBuilder.setHadDiagnosticsNES(suggestionInfo.source === 'diagnostics');
			all.then(([llmResult, diagnosticsResult]) => {
				telemetryBuilder.setHadLlmNES(!!llmResult?.result);
				telemetryBuilder.setHadDiagnosticsNES(!!diagnosticsResult?.result);
			});

			this.telemetrySender.scheduleSendingEnhancedTelemetry(suggestionInfo.suggestion, telemetryBuilder);

			return new NesCompletionList(context.requestUuid, inlineEdit, menuCommands, telemetryBuilder);
		} catch (e) {
			tracer.trace('error', e);
			logContext.setError(e);

			try {
				this.telemetrySender.sendTelemetry(suggestionInfo?.suggestion, telemetryBuilder);
			} finally {
				telemetryBuilder.dispose();
			}

			throw e;
		} finally {
			requestCancellationTokenSource.dispose();
			completionsCts.dispose();
			this.logger.add(logContext);
		}
	}

	public handleDidShowCompletionItem(completionItem: NesCompletionItem, updatedInsertText: string): void {
		completionItem.wasShown = true;
		completionItem.telemetryBuilder.setAsShown();

		const info = completionItem.info;
		this.logContextRecorder?.handleShown(info.suggestion);

		if (isLlmCompletionInfo(info)) {
			this.model.nextEditProvider.handleShown(info.suggestion);
		} else {
			this.model.diagnosticsBasedProvider?.handleShown(info.suggestion);
		}
	}

	public handleListEndOfLifetime(list: NesCompletionList, reason: InlineCompletionsDisposeReason): void {
		const tracer = this._tracer.sub(['handleListEndOfLifetime', shortOpportunityId(list.requestUuid)]);
		tracer.trace(`List ${list.requestUuid} disposed, reason: ${InlineCompletionsDisposeReasonKind[reason.kind]}`);

		const telemetryBuilder = list.telemetryBuilder;

		const disposeReasonStr = InlineCompletionsDisposeReasonKind[reason.kind];

		telemetryBuilder.setDisposalReason(disposeReasonStr);

		this.telemetrySender.sendTelemetryForBuilder(telemetryBuilder);
	}

	public handleEndOfLifetime(item: NesCompletionItem, reason: InlineCompletionEndOfLifeReason): void {
		const tracer = this._tracer.sub(['handleEndOfLifetime', shortOpportunityId(item.info.requestUuid)]);
		tracer.trace(`reason: ${InlineCompletionEndOfLifeReasonKind[reason.kind]}`);

		switch (reason.kind) {
			case InlineCompletionEndOfLifeReasonKind.Accepted: {
				this._handleAcceptance(item);
				break;
			}
			case InlineCompletionEndOfLifeReasonKind.Rejected: {
				this._handleDidRejectCompletionItem(item);
				break;
			}
			case InlineCompletionEndOfLifeReasonKind.Ignored: {
				const supersededBy = reason.supersededBy ? (reason.supersededBy as NesCompletionItem) : undefined;
				tracer.trace(`Superseded by: ${supersededBy?.info.requestUuid || 'none'}, was shown: ${item.wasShown}`);
				this._handleDidIgnoreCompletionItem(item, supersededBy);
				break;
			}
		}
	}

	private _handleAcceptance(item: NesCompletionItem) {
		this.logContextRecorder?.handleAcceptance(item.info.suggestion);

		item.telemetryBuilder.setAcceptance('accepted');
		item.telemetryBuilder.setStatus('accepted');

		const info = item.info;
		if (isLlmCompletionInfo(info)) {
			this.model.nextEditProvider.handleAcceptance(info.documentId, info.suggestion);
			this._trackSurvivalRate(info);
		} else {
			this.model.diagnosticsBasedProvider?.handleAcceptance(info.documentId, info.suggestion);
		}
	}

	// TODO: Support tracking Diagnostics NES
	private async _trackSurvivalRate(item: LlmCompletionInfo) {
		const result = item.suggestion.result;
		if (!result) {
			return;
		}

		const docBeforeEdits = result.documentBeforeEdits.value;
		const docAfterEdits = result.edit.toEdit().apply(docBeforeEdits);

		const recorder = this._instantiationService.createInstance(DocumentEditRecorder, item.document);

		// Assumption: The user cannot edit the document while the inline edit is being applied
		let userEdits = StringEdit.empty;
		softAssert(docAfterEdits === userEdits.apply(item.document.getText()));

		const diffedNextEdit = await stringEditFromDiff(docBeforeEdits, docAfterEdits, this._diffService);
		const recordedEdits = recorder.getEdits();

		userEdits = userEdits.compose(recordedEdits);

		this._instantiationService.createInstance(
			EditSurvivalReporter,
			item.document,
			result.documentBeforeEdits.value,
			diffedNextEdit,
			userEdits,
			{ includeArc: true },
			res => {
				/* __GDPR__
					"reportInlineEditSurvivalRate" : {
						"owner": "hediet",
						"comment": "Reports the survival rate for an inline edit.",
						"opportunityId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Unique identifier for an opportunity to show an NES." },

						"survivalRateFourGram": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the AI edit is still present in the document." },
						"survivalRateNoRevert": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The rate between 0 and 1 of how much of the ranges the AI touched ended up being reverted." },
						"didBranchChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Indicates if the branch changed in the meantime. If the branch changed (value is 1), this event should probably be ignored." },
						"timeDelayMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time delay between the user accepting the edit and measuring the survival rate." },
						"arc": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The accepted and restrained character count." }
					}
				*/
				this._telemetryService.sendTelemetryEvent('reportInlineEditSurvivalRate', { microsoft: true, github: { eventNamePrefix: 'copilot-nes/' } },
					{
						opportunityId: item.requestUuid,
					},
					{
						survivalRateFourGram: res.fourGram,
						survivalRateNoRevert: res.noRevert,
						didBranchChange: res.didBranchChange ? 1 : 0,
						timeDelayMs: res.timeDelayMs,
						arc: res.arc!,
					}
				);

			}
		);
	}

	private _handleDidRejectCompletionItem(completionItem: NesCompletionItem): void {
		this.logContextRecorder?.handleRejection(completionItem.info.suggestion);

		completionItem.telemetryBuilder.setAcceptance('rejected');
		completionItem.telemetryBuilder.setStatus('rejected');

		const info = completionItem.info;
		if (isLlmCompletionInfo(info)) {
			this.model.nextEditProvider.handleRejection(info.documentId, info.suggestion);
		} else {
			this.model.diagnosticsBasedProvider?.handleRejection(info.documentId, info.suggestion);
		}
	}

	private _handleDidIgnoreCompletionItem(item: NesCompletionItem, supersededBy?: NesCompletionItem): void {
		if (supersededBy) {
			item.telemetryBuilder.setSupersededBy(supersededBy.info.requestUuid);
		}

		const info = item.info;
		const supersededBySuggestion = supersededBy ? supersededBy.info.suggestion : undefined;
		if (isLlmCompletionInfo(info)) {
			this.model.nextEditProvider.handleIgnored(info.documentId, info.suggestion, supersededBySuggestion);
		} else {
			this.model.diagnosticsBasedProvider?.handleIgnored(info.documentId, info.suggestion, supersededBySuggestion);
		}
	}
}

/**
 * Runs multiple promises concurrently and provides two results:
 * 1. `first`: Resolves as soon as the first promise resolves, with a tuple where only the first resolved value is set, others are undefined..
 * 2. `all`: Resolves when all promises resolve, with a tuple of all results.
 * @param promises Tuple of promises to race
 */
export function raceAndAll<T extends readonly unknown[]>(
	promises: {
		[K in keyof T]: Promise<T[K]>;
	}
): {
	first: Promise<{
		[K in keyof T]: T[K] | undefined;
	}>;
	all: Promise<T>;
} {
	let settled = false;

	const first = new Promise<{
		[K in keyof T]: T[K] | undefined;
	}>((resolve, reject) => {
		promises.forEach((promise, index) => {
			promise.then(result => {
				if (settled) {
					return;
				}
				settled = true;
				const output = Array(promises.length).fill(undefined) as unknown[];
				output[index] = result;
				resolve(output as {
					[K in keyof T]: T[K] | undefined;
				});
			}, error => {
				settled = true;
				console.error(error);
				const output = Array(promises.length).fill(undefined) as unknown[];
				resolve(output as {
					[K in keyof T]: T[K] | undefined;
				});
			});
		});
	});

	const all = Promise.all(promises) as Promise<T>;

	return { first, all };
}

function shortOpportunityId(oppId: string): string {
	return oppId.substring(4, 8);
}
