/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Command, EndOfLine, InlineCompletionContext, InlineCompletionDisplayLocation, InlineCompletionDisplayLocationKind, InlineCompletionEndOfLifeReason, InlineCompletionEndOfLifeReasonKind, InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionList, InlineCompletionsDisposeReason, InlineCompletionsDisposeReasonKind, NotebookCell, NotebookCellKind, Position, Range, TextDocument, TextDocumentShowOptions, l10n, Event as vscodeEvent, window, workspace } from 'vscode';
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
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { findCell, findNotebook, isNotebookCell } from '../../../util/common/notebooks';
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
import { DiagnosticsNextEditResult } from './features/diagnosticsInlineEditProvider';
import { InlineEditModel } from './inlineEditModel';
import { learnMoreCommandId, learnMoreLink } from './inlineEditProviderFeature';
import { isInlineSuggestion } from './isInlineSuggestion';
import { InlineEditLogger } from './parts/inlineEditLogger';
import { IVSCodeObservableDocument } from './parts/vscodeWorkspace';
import { toExternalRange } from './utils/translations';
import { getNotebookId } from '../../../platform/notebook/common/helpers';

const learnMoreAction: Command = {
	title: l10n.t('Learn More'),
	command: learnMoreCommandId,
	tooltip: learnMoreLink
};

interface NesCompletionItem extends InlineCompletionItem {
	readonly telemetryBuilder: NextEditProviderTelemetryBuilder;
	readonly info: NesCompletionInfo;
	wasShown: boolean;
	isEditInAnotherDocument?: boolean;
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

const GoToNextEdit = l10n.t('Go To Next Edit');


export class InlineCompletionProviderImpl implements InlineCompletionItemProvider {
	public readonly displayName = 'Next Edit Suggestion';

	private readonly _tracer: ITracer;

	public readonly onDidChange: vscodeEvent<void> | undefined = Event.fromObservableLight(this.model.onChange);
	private readonly _displayNextEditorNES: boolean;

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
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		this._tracer = createTracer(['NES', 'Provider'], (s) => this._logService.trace(s));
		this._displayNextEditorNES = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.UseAlternativeNESNotebookFormat, this._expService);
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

		const documentVersion = (isNotebookCell(document.uri) ? findNotebook(document.uri, workspace.notebookDocuments)?.version : undefined) || document.version;
		const logContext = new InlineEditRequestLogContext(doc.id.uri, documentVersion, context);
		logContext.recordingBookmark = this.model.debugRecorder.createBookmark();

		const telemetryBuilder = new NextEditProviderTelemetryBuilder(this._gitExtensionService, this._notebookService, this._workspaceService, this.model.nextEditProvider.ID, doc, this.model.debugRecorder, logContext.recordingBookmark);
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
			let isInlineCompletion: boolean = false;
			let completionItem: Omit<NesCompletionItem, 'telemetryBuilder' | 'info' | 'showInlineEditMenu' | 'action' | 'wasShown' | 'isInlineEdit'> | undefined;

			const documents = doc.fromOffsetRange(result.edit.replaceRange);
			const [targetDocument, range] = documents.length ? documents[0] : [undefined, undefined];

			addNotebookTelemetry(document, position, result.edit.newText, documents, telemetryBuilder);
			telemetryBuilder.setIsActiveDocument(window.activeTextEditor?.document === targetDocument);

			if (!targetDocument) {
				tracer.trace('no next edit suggestion');
			} else if (hasNotebookCellMarker(document, result.edit.newText)) {
				tracer.trace('no next edit suggestion, edits contain Notebook Cell Markers');
			} else if (targetDocument === document) {
				// nes is for this same document.
				const allowInlineCompletions = this.model.inlineEditsInlineCompletionsEnabled.get();
				isInlineCompletion = allowInlineCompletions && isInlineSuggestion(position, document, range, result.edit.newText);
				completionItem = serveAsCompletionsProvider && !isInlineCompletion ?
					undefined :
					this.createCompletionItem(doc, document, position, range, result);
			} else if (this._displayNextEditorNES) {
				// nes is for a different document.
				completionItem = serveAsCompletionsProvider ?
					undefined :
					this.createNextEditorEditCompletionItem(position, {
						document: targetDocument,
						insertText: result.edit.newText,
						range
					});
			}

			if (!completionItem) {
				this.telemetrySender.scheduleSendingEnhancedTelemetry(suggestionInfo.suggestion, telemetryBuilder);
				return emptyList;
			}

			const menuCommands: InlineCompletionCommand[] = [];
			if (this.inlineEditDebugComponent) {
				menuCommands.push(...this.inlineEditDebugComponent.getCommands(logContext));
			}


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

			const nesCompletionItem: NesCompletionItem = {
				...completionItem,
				info: suggestionInfo,
				telemetryBuilder,
				action: learnMoreAction,
				isInlineEdit: !isInlineCompletion,
				showInlineEditMenu: !serveAsCompletionsProvider,
				wasShown: false
			};

			return new NesCompletionList(context.requestUuid, nesCompletionItem, menuCommands, telemetryBuilder);
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

	private createNextEditorEditCompletionItem(requestingPosition: Position,
		nextEdit: { document: TextDocument; range: Range; insertText: string }
	): Omit<NesCompletionItem, 'telemetryBuilder' | 'info' | 'showInlineEditMenu' | 'action' | 'wasShown' | 'isInlineEdit'> {
		// Display the next edit in the current document, but with a command to open the next edit in the other document.
		// & range of this completion item will be the same as the current documents cursor position.
		const range = new Range(requestingPosition, requestingPosition);
		const displayLocation: InlineCompletionDisplayLocation = {
			range,
			label: GoToNextEdit,
			kind: InlineCompletionDisplayLocationKind.Label
		};

		const commandArgs: TextDocumentShowOptions = {
			preserveFocus: false,
			selection: new Range(nextEdit.range.start, nextEdit.range.start)
		};
		const command: Command = {
			command: 'vscode.open',
			title: GoToNextEdit,
			arguments: [nextEdit.document.uri, commandArgs]
		};
		return {
			range,
			insertText: nextEdit.insertText,
			showRange: range,
			command,
			displayLocation,
			isEditInAnotherDocument: true
		};
	}

	private createCompletionItem(
		doc: IVSCodeObservableDocument,
		document: TextDocument,
		position: Position,
		range: Range,
		result: NonNullable<(NextEditResult | DiagnosticsNextEditResult)['result']>,
	): Omit<NesCompletionItem, 'telemetryBuilder' | 'info' | 'showInlineEditMenu' | 'action' | 'wasShown' | 'isInlineEdit'> | undefined {

		// Only show edit when the cursor is max 4 lines away from the edit
		const showRange = result.showRangePreference === ShowNextEditPreference.AroundEdit
			? new Range(
				Math.max(range.start.line - 4, 0),
				0,
				range.end.line + 4,
				Number.MAX_SAFE_INTEGER
			) : undefined;

		const displayLocationRange = result.displayLocation && doc.fromRange(document, toExternalRange(result.displayLocation.range));
		const displayLocation: InlineCompletionDisplayLocation | undefined = result.displayLocation && displayLocationRange ? {
			range: displayLocationRange,
			label: result.displayLocation.label,
			kind: InlineCompletionDisplayLocationKind.Code
		} : undefined;


		return {
			range,
			insertText: result.edit.newText,
			showRange,
			displayLocation,
		};
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
			if (!item.isEditInAnotherDocument) {
				this._trackSurvivalRate(info);
			}
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

function hasNotebookCellMarker(document: TextDocument, newText: string) {
	return isNotebookCell(document.uri) && newText.includes('%% vscode.cell [id=');
}

function addNotebookTelemetry(document: TextDocument, position: Position, newText: string, documents: [TextDocument, Range][], telemetryBuilder: NextEditProviderTelemetryBuilder) {
	const notebook = isNotebookCell(document.uri) ? findNotebook(document.uri, workspace.notebookDocuments) : undefined;
	const cell = notebook ? findCell(document.uri, notebook) : undefined;
	if (!cell || !notebook || !documents.length) {
		return;
	}
	const cellMarkerCount = newText.match(/%% vscode.cell \[id=/g)?.length || 0;
	const cellMarkerIndex = newText.indexOf('#%% vscode.cell [id=');
	const isMultiline = newText.includes('\n');
	const targetEol = documents[0][0].eol === EndOfLine.CRLF ? '\r\n' : '\n';
	const sourceEol = newText.includes('\r\n') ? '\r\n' : (newText.includes('\n') ? '\n' : targetEol);
	const nextEditor = window.visibleTextEditors.find(editor => editor.document === documents[0][0]);
	const isNextEditorRangeVisible = nextEditor && nextEditor.visibleRanges.some(range => range.contains(documents[0][1]));
	const notebookId = getNotebookId(notebook);
	const lineSuffix = `(${position.line}:${position.character})`;
	const getCellPrefix = (c: NotebookCell) => {
		if (c === cell) {
			return `*`;
		}
		if (c.document === documents[0][0]) {
			return `+`;
		}
		return '';
	};
	const lineCounts = notebook.getCells()
		.filter(c => c.kind === NotebookCellKind.Code)
		.map(c => `${getCellPrefix(c)}${c.document.lineCount}${c === cell ? lineSuffix : ''}`).join(',');
	telemetryBuilder.
		setNotebookCellMarkerIndex(cellMarkerIndex)
		.setNotebookCellMarkerCount(cellMarkerCount)
		.setIsMultilineEdit(isMultiline)
		.setIsEolDifferent(targetEol !== sourceEol)
		.setIsNextEditorVisible(!!nextEditor)
		.setIsNextEditorRangeVisible(!!isNextEditorRangeVisible)
		.setNotebookCellLines(lineCounts)
		.setNotebookId(notebookId)
		.setIsNESForOtherEditor(documents[0][0] !== document);
}
