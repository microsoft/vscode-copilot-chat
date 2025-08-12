/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { StringTextDocument } from '../../../platform/editing/common/abstractText';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { DebugRecorderBookmark } from '../../../platform/inlineEdits/common/debugRecorderBookmark';
import { IObservableDocument } from '../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditTelemetry, StatelessNextEditRequest } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { autorunWithChanges } from '../../../platform/inlineEdits/common/utils/observable';
import { APIUsage } from '../../../platform/networking/common/openai';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { ITelemetryService, multiplexProperties, TelemetryEventMeasurements, TelemetryEventProperties } from '../../../platform/telemetry/common/telemetry';
import { LogEntry } from '../../../platform/workspaceRecorder/common/workspaceLog';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../util/vs/base/common/network';
import { StringEdit, StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { Uri } from '../../../vscodeTypes';
import { ProjectedDocument } from '../../prompts/node/inline/summarizedDocument/implementation';
import { ProjectedText } from '../../prompts/node/inline/summarizedDocument/projectedText';
import { DebugRecorder } from './debugRecorder';
import { INesConfigs } from './nesConfigs';
import { INextEditDisplayLocation, INextEditResult } from './nextEditResult';

export type NextEditTelemetryStatus = 'new' | 'requested' | `noEdit:${string}` | 'docChanged' | 'emptyEdits' | 'previouslyRejected' | 'previouslyRejectedCache' | 'accepted' | 'notAccepted' | 'rejected';

export type NesAcceptance = 'accepted' | 'notAccepted' | 'rejected';

export interface IAlternativeAction {
	readonly text: string | undefined; // undefined if the text is too long
	readonly textLength: number;
	readonly selection: ITelemetryRange[];
	readonly edits: ITelemetryEdit[];
	readonly summarizedText: string | undefined;
	readonly summarizedTextLength: number | undefined;
	readonly summarizedEdits: ITelemetryEdit[] | undefined;
	readonly tags: string[];
	readonly recording: ITelemetryRecording | undefined;
}

export interface ITelemetryEdit {
	readonly time: string;
	readonly start: number;
	readonly endExclusive: number;
	readonly newText: string;
}

export interface ITelemetryRange {
	readonly start: number;
	readonly endExclusive: number;
}

export interface ITelemetryRecording {
	readonly entries: LogEntry[] | undefined;
	readonly entriesSize: number;
	readonly requestTime: number;
}

export interface ILlmNESTelemetry extends Partial<IStatelessNextEditTelemetry> { // it's partial because the next edit can be pulled from cache resulting in no stateless provider telemetry
	readonly providerId: string;
	readonly headerRequestId: string;
	readonly nextEditProviderDuration: number;
	readonly fetchStartedAfterMs: number | undefined;
	readonly isFromCache: boolean;
	readonly subsequentEditOrder: number | undefined;
	readonly activeDocumentOriginalLineCount: number | undefined;
	readonly activeDocumentEditsCount: number | undefined;
	readonly activeDocumentLanguageId: string | undefined;
	readonly activeDocumentRepository: string | undefined;
	readonly hasNextEdit: boolean;
	readonly wasPreviouslyRejected: boolean;
	readonly status: NextEditTelemetryStatus;
	readonly nesConfigs: INesConfigs | undefined;
	readonly repositoryUrls: string[] | undefined;
	readonly documentsCount: number | undefined;
	readonly editsCount: number | undefined;
	readonly isNotebook: boolean;
	readonly alternativeAction: IAlternativeAction | undefined;
}

export interface IDiagnosticsTelemetry {
	readonly diagnosticType: string | undefined;
	readonly diagnosticDroppedReasons: string | undefined;
	readonly diagnosticDistanceToUnknownDiagnostic: number | undefined;
	readonly diagnosticDistanceToAlternativeDiagnostic: number | undefined;
	readonly diagnosticHasAlternativeDiagnosticForSameRange: boolean | undefined;

	// imports
	readonly diagnosticHasExistingSameFileImport: boolean | undefined;
	readonly diagnosticIsLocalImport: boolean | undefined;
	readonly diagnosticAlternativeImportsCount: number | undefined;
}

export interface INextEditProviderTelemetry extends ILlmNESTelemetry, IDiagnosticsTelemetry {
	readonly opportunityId: string;
	readonly requestN: number;
	readonly isShown: boolean;
	readonly acceptance: NesAcceptance;
	readonly disposalReason: string | undefined;
	readonly supersededByOpportunityId: string | undefined;
	readonly status: NextEditTelemetryStatus;
	readonly activeDocumentRepository: string | undefined;
	readonly repositoryUrls: string[] | undefined;
	readonly alternativeAction: IAlternativeAction | undefined;
	readonly postProcessingOutcome: string | undefined;
	readonly isNaturalLanguageDominated: boolean;

	readonly hadLlmNES: boolean;
	readonly hadDiagnosticsNES: boolean;
	readonly pickedNES: 'llm' | 'diagnostics' | undefined;
	readonly configIsDiagnosticsNESEnabled: boolean;
}

export class LlmNESTelemetryBuilder extends Disposable {

	public build(includeAlternativeAction: boolean): ILlmNESTelemetry {
		let documentsCount: number | undefined = undefined;
		let editsCount: number | undefined = undefined;
		let activeDocumentEditsCount: number | undefined = undefined;
		let activeDocumentLanguageId: string | undefined = undefined;
		let activeDocumentOriginalLineCount: number | undefined = undefined;
		let isNotebook: boolean = false;
		let activeDocumentRepository: string | undefined = undefined;
		let repositoryUrls: string[] | undefined = undefined;

		if (this._request) {
			const activeDoc = this._request.getActiveDocument();
			documentsCount = this._request.documents.length;
			editsCount = this._request.documents.reduce((acc, doc) => acc + doc.recentEdits.edits.length, 0);
			activeDocumentEditsCount = activeDoc.recentEdits.edits.length;
			activeDocumentLanguageId = activeDoc.languageId;
			activeDocumentOriginalLineCount = activeDoc.documentAfterEditsLines.length;
			isNotebook = activeDoc.id.toUri().scheme === Schemas.vscodeNotebookCell || this._notebookService.hasSupportedNotebooks(activeDoc.id.toUri());
			const git = this._gitExtensionService.getExtensionApi();
			if (git) {
				const activeDocRepository = git.getRepository(Uri.parse(activeDoc.id.uri));
				if (activeDocRepository) {
					const remoteName = activeDocRepository.state.HEAD?.upstream?.remote;
					const remote = activeDocRepository.state.remotes.find(r => r.name === remoteName);
					if (remote?.fetchUrl) {
						activeDocumentRepository = remote.pushUrl || remote.fetchUrl;
					}
				}

				const remoteUrlSet = new Set<string>();
				const repositories = [...new Set(this._request.documents.map(doc => git.getRepository(Uri.parse(doc.id.uri))).filter(Boolean))];
				for (const repository of repositories) {
					const remoteName = repository?.state.HEAD?.upstream?.remote;
					const remote = repository?.state.remotes.find(r => r.name === remoteName);
					if (remote?.fetchUrl) {
						remoteUrlSet.add(remote.fetchUrl);
					}
					if (remote?.pushUrl) {
						remoteUrlSet.add(remote.pushUrl);
					}
				}
				repositoryUrls = [...remoteUrlSet];
			}
		}

		let alternativeAction: IAlternativeAction | undefined;
		if (includeAlternativeAction) {
			const tags: string[] = [];
			const projDoc: ProjectedDocument<StringTextDocument> | undefined = this._statelessNextEditTelemetry?.summarizedEditWindow;
			if (projDoc && projDoc.originalText !== this._originalDoc.value) {
				tags.push('original_texts_deviate');
			}
			const originalText = projDoc ? projDoc.originalText : this._originalDoc.value;
			const summarizedText = projDoc?.text;
			let summarizedEdits: { time: Date; edit: StringEdit }[] | undefined;
			if (projDoc) {
				let currentProjText: ProjectedText = projDoc;
				const projEdits: { time: Date; edit: StringEdit }[] = summarizedEdits = [];
				for (const { time, edit } of this._edits) {
					const rebased = currentProjText.tryRebase(edit);
					if (!rebased) {
						tags.push('user_edit_conflict_with_summarization');
						break;
					}
					currentProjText = rebased.text;
					projEdits.push({
						time,
						edit: rebased.edit,
					});
				}
			}
			let recording: ITelemetryRecording | undefined;
			if (this._debugRecorder && this._requestBookmark) {
				const entries = this._debugRecorder.getRecentLog();
				const entriesSize = JSON.stringify(entries)?.length || 0;
				recording = {
					entries: entriesSize > 200 * 1024 ? undefined : entries,
					entriesSize: entriesSize,
					requestTime: this._requestBookmark.timeMs,
				};
			}
			alternativeAction = {
				text: originalText.length > 200 * 1024 ? undefined : originalText,
				textLength: originalText.length,
				selection: this._originalSelection.map(range => ({
					start: range.start,
					endExclusive: range.endExclusive,
				})),
				edits: this._edits.map(edit => edit.edit.replacements.map(e => ({
					time: edit.time.toISOString(),
					start: e.replaceRange.start,
					endExclusive: e.replaceRange.endExclusive,
					newText: e.newText,
				}))).flat(),
				summarizedText,
				summarizedTextLength: summarizedText?.length,
				summarizedEdits: summarizedEdits?.map(edit => edit.edit.replacements.map(e => ({
					time: edit.time.toISOString(),
					start: e.replaceRange.start,
					endExclusive: e.replaceRange.endExclusive,
					newText: e.newText,
				}))).flat(),
				tags,
				recording,
			};
		}

		const fetchStartedAfterMs = this._statelessNextEditTelemetry?.fetchStartedAt === undefined ? undefined : this._statelessNextEditTelemetry.fetchStartedAt - this._startTime;

		return {
			providerId: this._providerId,
			headerRequestId: this._headerRequestId || '',
			nextEditProviderDuration: this._duration || 0,
			isFromCache: this._isFromCache,
			subsequentEditOrder: this._subsequentEditOrder,
			documentsCount,
			editsCount,
			activeDocumentEditsCount,
			activeDocumentLanguageId,
			activeDocumentOriginalLineCount,
			fetchStartedAfterMs,
			hasNextEdit: this._hasNextEdit,
			wasPreviouslyRejected: this._wasPreviouslyRejected,
			isNotebook: isNotebook,
			status: this._status,
			alternativeAction,

			...this._statelessNextEditTelemetry,

			activeDocumentRepository,
			repositoryUrls,

			nesConfigs: this._nesConfigs,
		};
	}

	private _startTime: number;
	private _originalDoc: StringText;
	private _originalSelection: readonly OffsetRange[];
	private _edits: { time: Date; edit: StringEdit }[] = [];

	constructor(
		private readonly _gitExtensionService: IGitExtensionService,
		private readonly _notebookService: INotebookService,
		private readonly _providerId: string,
		private readonly _doc: IObservableDocument,
		private readonly _debugRecorder?: DebugRecorder,
		private readonly _requestBookmark?: DebugRecorderBookmark,
	) {
		super();
		this._startTime = Date.now();

		this._originalDoc = this._doc.value.get();
		this._originalSelection = this._doc.selection.get();

		this._store.add(autorunWithChanges(this, {
			value: this._doc.value,
		}, (data) => {
			const time = new Date();
			data.value.changes.forEach(change => {
				this._edits.push({
					time,
					edit: change,
				});
			});
		}));
	}

	private _nesConfigs: INesConfigs | undefined;
	public setNESConfigs(nesConfigs: INesConfigs): this {
		this._nesConfigs = nesConfigs;
		return this;
	}

	private _headerRequestId: string | undefined;
	public setHeaderRequestId(uuid: string): this {
		this._headerRequestId = uuid;
		return this;
	}

	private _isFromCache: boolean = false;
	public setIsFromCache(): this {
		this._isFromCache = true;
		return this;
	}

	private _subsequentEditOrder: number | undefined;
	public setSubsequentEditOrder(subsequentEditOrder: number | undefined): this {
		this._subsequentEditOrder = subsequentEditOrder;
		return this;
	}

	private _request: StatelessNextEditRequest | undefined;
	public setRequest(request: StatelessNextEditRequest): this {
		this._request = request;
		return this;
	}

	private _statelessNextEditTelemetry: IStatelessNextEditTelemetry | undefined;
	public setStatelessNextEditTelemetry(statelessNextEditTelemetry: IStatelessNextEditTelemetry): this {
		this._statelessNextEditTelemetry = statelessNextEditTelemetry;
		return this;
	}

	private _hasNextEdit: boolean = false;
	public setHasNextEdit(hasNextEdit: boolean): this {
		this._hasNextEdit = hasNextEdit;
		return this;
	}

	private _wasPreviouslyRejected: boolean = false;
	public setWasPreviouslyRejected(): this {
		this._wasPreviouslyRejected = true;
		return this;
	}

	private _duration: number | undefined;
	public markEndTime(): this {
		this._duration = Date.now() - this._startTime;
		return this;
	}

	private _status: NextEditTelemetryStatus = 'new';
	public setStatus(status: NextEditTelemetryStatus): this {
		this._status = status;
		return this;
	}
}

interface IDiagnosticTelemetryRun {
	alternativeImportsCount?: number;
	hasExistingSameFileImport?: boolean;
	isLocalImport?: boolean;
	distanceToUnknownDiagnostic?: number;
	distanceToAlternativeDiagnostic?: number;
	hasAlternativeDiagnosticForSameRange?: boolean;
}

export class DiagnosticsTelemetryBuilder {

	public build(): IDiagnosticsTelemetry {
		const diagnosticDroppedReasons = this._droppedReasons.length > 0 ? JSON.stringify(this._droppedReasons) : undefined;
		return {
			diagnosticType: this._type,
			diagnosticDroppedReasons,
			diagnosticAlternativeImportsCount: this._diagnosticRunTelemetry?.alternativeImportsCount,
			diagnosticHasExistingSameFileImport: this._diagnosticRunTelemetry?.hasExistingSameFileImport,
			diagnosticIsLocalImport: this._diagnosticRunTelemetry?.isLocalImport,
			diagnosticDistanceToUnknownDiagnostic: this._diagnosticRunTelemetry?.distanceToUnknownDiagnostic,
			diagnosticDistanceToAlternativeDiagnostic: this._diagnosticRunTelemetry?.distanceToAlternativeDiagnostic,
			diagnosticHasAlternativeDiagnosticForSameRange: this._diagnosticRunTelemetry?.hasAlternativeDiagnosticForSameRange
		};
	}

	public populate(telemetry: DiagnosticsTelemetryBuilder) {
		this._droppedReasons.forEach(reason => telemetry.addDroppedReason(reason));
		if (this._type) {
			telemetry.setType(this._type);
		}
		if (this._diagnosticRunTelemetry) {
			telemetry.setDiagnosticRunTelemetry(this._diagnosticRunTelemetry);
		}
	}

	private _type: string | undefined;
	setType(type: string): this {
		this._type = type;
		return this;
	}

	private _droppedReasons: string[] = [];
	addDroppedReason(reason: string): this {
		this._droppedReasons.push(reason);
		return this;
	}

	private _diagnosticRunTelemetry: IDiagnosticTelemetryRun | undefined;
	setDiagnosticRunTelemetry(diagnosticRun: IDiagnosticTelemetryRun): this {
		this._diagnosticRunTelemetry = diagnosticRun;
		return this;
	}
}

export class NextEditProviderTelemetryBuilder extends Disposable {

	private static requestN = 0;

	/**
	 * Whether telemetry for this builder has been sent -- only for ordinary telemetry, not enhanced telemetry
	 */
	private _isSent: boolean = false;
	public get isSent(): boolean {
		return this._isSent;
	}
	public markAsSent(): void {
		this._isSent = true;
	}

	public build(includeAlternativeAction: boolean): INextEditProviderTelemetry {

		const nesTelemetry = this._nesBuilder.build(includeAlternativeAction);
		const diagnosticsTelemetry = this._diagnosticsBuilder.build();

		return {
			...nesTelemetry,
			...diagnosticsTelemetry,

			opportunityId: this._opportunityId || '',
			requestN: this._requestN,
			isShown: this._isShown,
			acceptance: this._acceptance,
			disposalReason: this._disposalReason,
			supersededByOpportunityId: this._supersededByOpportunityId,
			pickedNES: this._nesTypePicked,
			hadLlmNES: this._hadLlmNES,
			hadDiagnosticsNES: this._hadDiagnosticsNES,
			configIsDiagnosticsNESEnabled: this._configIsDiagnosticsNESEnabled,
			isNaturalLanguageDominated: this._isNaturalLanguageDominated,
			postProcessingOutcome: this._postProcessingOutcome,
		};
	}

	private _requestN: number;

	private readonly _nesBuilder: LlmNESTelemetryBuilder;
	public get nesBuilder(): LlmNESTelemetryBuilder {
		return this._nesBuilder;
	}
	private readonly _diagnosticsBuilder: DiagnosticsTelemetryBuilder;
	public get diagnosticsBuilder(): DiagnosticsTelemetryBuilder {
		return this._diagnosticsBuilder;
	}

	constructor(
		gitExtensionService: IGitExtensionService,
		notebookService: INotebookService,
		providerId: string,
		doc: IObservableDocument,
		debugRecorder?: DebugRecorder,
		requestBookmark?: DebugRecorderBookmark,
	) {
		super();
		this._requestN = ++NextEditProviderTelemetryBuilder.requestN;

		this._nesBuilder = this._register(new LlmNESTelemetryBuilder(gitExtensionService, notebookService, providerId, doc, debugRecorder, requestBookmark));
		this._diagnosticsBuilder = new DiagnosticsTelemetryBuilder();
	}

	private _opportunityId: string | undefined;
	public setOpportunityId(uuid: string): this {
		this._opportunityId = uuid;
		return this;
	}

	private _isShown: boolean = false;
	public setAsShown(): this {
		this._isShown = true;
		return this;
	}

	private _acceptance: NesAcceptance = 'notAccepted';
	public setAcceptance(acceptance: NesAcceptance): this {
		this._acceptance = acceptance;
		return this;
	}

	private _disposalReason: string | undefined = undefined;
	public setDisposalReason(disposalReason: string | undefined): this {
		this._disposalReason = disposalReason;
		return this;
	}

	private _supersededByOpportunityId: string | undefined = undefined;
	public setSupersededBy(opportunityId: string | undefined): this {
		this._supersededByOpportunityId = opportunityId;
		return this;
	}

	private _nesTypePicked: 'llm' | 'diagnostics' | undefined;
	public setPickedNESType(nesTypePicked: 'llm' | 'diagnostics'): this {
		this._nesTypePicked = nesTypePicked;
		return this;
	}

	private _hadLlmNES: boolean = false;
	public setHadLlmNES(boolean: boolean): this {
		this._hadLlmNES = boolean;
		return this;
	}

	private _hadDiagnosticsNES: boolean = false;
	public setHadDiagnosticsNES(boolean: boolean): this {
		this._hadDiagnosticsNES = boolean;
		return this;
	}

	public setStatus(status: NextEditTelemetryStatus): this {
		this._nesBuilder.setStatus(status);
		return this;
	}

	private _configIsDiagnosticsNESEnabled: boolean = false;
	public setConfigIsDiagnosticsNESEnabled(boolean: boolean): this {
		this._configIsDiagnosticsNESEnabled = boolean;
		return this;
	}

	private _isNaturalLanguageDominated: boolean = false;
	public setIsNaturalLanguageDominated(isNaturalLanguageDominated: boolean): this {
		this._isNaturalLanguageDominated = isNaturalLanguageDominated;
		return this;
	}

	private _postProcessingOutcome: string | undefined;
	public setPostProcessingOutcome(suggestion: {
		edit: StringReplacement;
		isInlineCompletion: boolean;
		displayLocation?: INextEditDisplayLocation;
	}): this {
		const displayLocation = suggestion.displayLocation ? {
			label: suggestion.displayLocation.label,
			range: suggestion.displayLocation.range.toString()
		} : undefined;

		this._postProcessingOutcome = JSON.stringify({
			suggestedEdit: suggestion.edit.toString(),
			isInlineCompletion: suggestion.isInlineCompletion,
			displayLocation
		});

		return this;
	}
}

export class TelemetrySender implements IDisposable {

	private readonly _map = new Map<INextEditResult, { builder: NextEditProviderTelemetryBuilder; timeout: NodeJS.Timeout }>();

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
	}

	/**
	 * Schedule sending telemetry for the next edit result in case it gets ignored by user (ie is not accepted or rejected, so gets replaced by another edit)
	 */
	public scheduleSendingEnhancedTelemetry(nextEditResult: INextEditResult, builder: NextEditProviderTelemetryBuilder): void {
		const timeout = setTimeout(() => {
			let telemetry: INextEditProviderTelemetry;
			this._map.delete(nextEditResult);
			try {
				telemetry = builder.build(true);
			} finally {
				builder.dispose();
			}
			this._doSendEnhancedTelemetry(telemetry);
		}, /* 2 minutes */ 2 * 60 * 1000);
		this._map.set(nextEditResult, { builder, timeout });
	}

	/**
	 * Send telemetry for the next edit result in case it has already been rejected or contains no edits to be shown.
	 */
	public sendTelemetry(nextEditResult: INextEditResult | undefined, builder: NextEditProviderTelemetryBuilder): void {
		if (nextEditResult) {
			const data = this._map.get(nextEditResult);
			if (data) {
				clearTimeout(data.timeout);
				this._map.delete(nextEditResult);
			}
		}
		const telemetry = builder.build(true);
		if (!builder.isSent) {
			this._doSendTelemetry(telemetry);
			builder.markAsSent();
		}
		this._doSendEnhancedTelemetry(telemetry);
	}

	public sendTelemetryForBuilder(builder: NextEditProviderTelemetryBuilder): void {
		if (builder.isSent) {
			return;
		}
		const telemetry = builder.build(false); // disposal is done by enhanced telemetry sending in a setTimeout callback
		this._doSendTelemetry(telemetry);
		builder.markAsSent();
	}

	private async _doSendTelemetry(telemetry: INextEditProviderTelemetry): Promise<void> {
		const {
			opportunityId,
			headerRequestId,
			requestN,
			providerId,
			modelName,
			hadStatelessNextEditProviderCall,
			statelessNextEditProviderDuration,
			nextEditProviderDuration,
			isFromCache,
			subsequentEditOrder,
			activeDocumentLanguageId,
			activeDocumentOriginalLineCount,
			nLinesOfCurrentFileInPrompt,
			wasPreviouslyRejected,
			isShown,
			isNotebook,
			acceptance,
			disposalReason,
			logProbThreshold,
			documentsCount,
			editsCount,
			activeDocumentEditsCount,
			promptLineCount,
			promptCharCount,
			hadLowLogProbSuggestion,
			nEditsSuggested,
			lineDistanceToMostRecentEdit,
			isCursorAtEndOfLine,
			debounceTime,
			artificialDelay,
			hasNextEdit,
			nextEditLogprob,
			supersededByOpportunityId,
			noNextEditReasonKind,
			noNextEditReasonMessage,
			fetchStartedAfterMs,
			response: responseWithStats,
			configIsDiagnosticsNESEnabled,
			isNaturalLanguageDominated,
			diagnosticType,
			diagnosticDroppedReasons,
			diagnosticHasExistingSameFileImport,
			diagnosticIsLocalImport,
			diagnosticAlternativeImportsCount,
			diagnosticDistanceToUnknownDiagnostic,
			diagnosticDistanceToAlternativeDiagnostic,
			diagnosticHasAlternativeDiagnosticForSameRange,
			hadDiagnosticsNES,
			hadLlmNES,
			pickedNES,
		} = telemetry;

		let usage: APIUsage | undefined;
		let ttft_: number | undefined;
		let fetchResult_: ChatFetchResponseType | undefined;
		let fetchTime_: number | undefined;
		if (responseWithStats !== undefined) {
			const { response, ttft, fetchResult, fetchTime } = await responseWithStats;
			if (response.type === ChatFetchResponseType.Success) {
				usage = response.usage;
			}
			ttft_ = ttft;
			fetchResult_ = fetchResult;
			fetchTime_ = fetchTime;
		}

		/* __GDPR__
	"provideInlineEdit" : {
		"owner": "ulugbekna",
		"comment": "Telemetry for inline edit (NES) provided",
		"opportunityId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Unique identifier for an opportunity to show an NES." },
		"headerRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Unique identifier of the network request which is also included in the fetch request header." },
		"providerId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "NES provider identifier (StatelessNextEditProvider)" },
		"modelName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Name of the model used to provide the NES" },
		"activeDocumentLanguageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "LanguageId of the active document" },
		"acceptance": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "User acceptance of the edit" },
		"disposalReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reason for disposal of NES" },
		"supersededByOpportunityId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "UUID of the opportunity that superseded this edit" },
		"endpoint": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Endpoint for the request" },
		"noNextEditReasonKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reason kind for no next edit" },
		"noNextEditReasonMessage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reason message for no next edit" },
		"fetchResult": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Fetch result" },
		"fetchError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Fetch error message" },
		"pickedNES": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request had picked NES" },
		"diagnosticType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Type of diagnostics" },
		"diagnosticDroppedReasons": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Reasons for dropping diagnostics NES suggestions" },
		"requestN": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Request number", "isMeasurement": true },
		"hadStatelessNextEditProviderCall": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request had a stateless next edit provider call", "isMeasurement": true },
		"statelessNextEditProviderDuration": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Duration of stateless next edit provider", "isMeasurement": true },
		"nextEditProviderDuration": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Duration of next edit provider", "isMeasurement": true },
		"isFromCache": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the edit was provided from cache", "isMeasurement": true },
		"subsequentEditOrder": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Order of the subsequent edit", "isMeasurement": true },
		"activeDocumentOriginalLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of lines in the active document before shortening", "isMeasurement": true },
		"activeDocumentNLinesInPrompt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of lines in the active document included in prompt", "isMeasurement": true },
		"wasPreviouslyRejected": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the edit was previously rejected", "isMeasurement": true },
		"isShown": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the edit was shown", "isMeasurement": true },
		"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the document is a notebook", "isMeasurement": true },
		"logProbThreshold": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Log probability threshold for the edit", "isMeasurement": true },
		"documentsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of documents", "isMeasurement": true },
		"editsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of edits", "isMeasurement": true },
		"activeDocumentEditsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of edits in the active document", "isMeasurement": true },
		"promptLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of lines in the prompt", "isMeasurement": true },
		"promptCharCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of characters in the prompt", "isMeasurement": true },
		"hadLowLogProbSuggestion": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the suggestion had low log probability", "isMeasurement": true },
		"nEditsSuggested": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of edits suggested", "isMeasurement": true },
		"hasNextEdit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether next edit provider returned an edit (if an edit was previously rejected, this field is false)", "isMeasurement": true },
		"nextEditLogprob": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Log probability of the next edit", "isMeasurement": true },
		"lineDistanceToMostRecentEdit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Line distance to most recent edit", "isMeasurement": true },
		"isCursorAtEndOfLine": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the cursor is at the end of the line", "isMeasurement": true },
		"debounceTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Debounce time", "isMeasurement": true },
		"artificialDelay": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Artificial delay (aka backoff) on the response based on previous user acceptance/rejection in milliseconds", "isMeasurement": true },
		"fetchStartedAfterMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time from inline edit provider invocation to fetch init", "isMeasurement": true },
		"ttft": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time to first token", "isMeasurement": true },
		"fetchTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Time from fetch init to end of stream", "isMeasurement": true },
		"promptTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prompt", "isMeasurement": true },
		"responseTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the response", "isMeasurement": true },
		"cachedTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of cached tokens in the response", "isMeasurement": true },
		"acceptedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
		"rejectedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
		"hadDiagnosticsNES": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request had diagnostics NES", "isMeasurement": true },
		"hadLlmNES": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request had LLM NES", "isMeasurement": true },
		"configIsDiagnosticsNESEnabled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether diagnostics NES is enabled", "isMeasurement": true },
		"isNaturalLanguageDominated": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the context is dominated by natural language", "isMeasurement": true },
		"diagnosticHasExistingSameFileImport": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the diagnostic has an existing same file import", "isMeasurement": true },
		"diagnosticIsLocalImport": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the diagnostic is a local import", "isMeasurement": true },
		"diagnosticAlternativeImportsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of alternative imports for the diagnostic", "isMeasurement": true },
		"diagnosticDistanceToUnknownDiagnostic": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Distance to the unknown diagnostic", "isMeasurement": true },
		"diagnosticDistanceToAlternativeDiagnostic": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Distance to the alternative diagnostic", "isMeasurement": true },
		"diagnosticHasAlternativeDiagnosticForSameRange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether there is an alternative diagnostic for the same range", "isMeasurement": true }
	}
*/
		this._sendTelemetryToBoth(
			{
				opportunityId,
				headerRequestId,
				providerId,
				modelName,
				activeDocumentLanguageId,
				acceptance,
				disposalReason,
				supersededByOpportunityId,
				noNextEditReasonKind,
				noNextEditReasonMessage,
				fetchResult: fetchResult_,
				diagnosticType,
				diagnosticDroppedReasons,
				pickedNES,
			},
			{
				requestN,
				hadStatelessNextEditProviderCall: this._boolToNum(hadStatelessNextEditProviderCall),
				statelessNextEditProviderDuration,
				nextEditProviderDuration,
				isFromCache: this._boolToNum(isFromCache),
				subsequentEditOrder,
				activeDocumentOriginalLineCount,
				activeDocumentNLinesInPrompt: nLinesOfCurrentFileInPrompt,
				wasPreviouslyRejected: this._boolToNum(wasPreviouslyRejected),
				isShown: this._boolToNum(isShown),
				isNotebook: this._boolToNum(isNotebook),
				logProbThreshold,
				documentsCount,
				editsCount,
				activeDocumentEditsCount,
				promptLineCount,
				promptCharCount,
				hadLowLogProbSuggestion: this._boolToNum(hadLowLogProbSuggestion),
				nEditsSuggested,
				lineDistanceToMostRecentEdit,
				isCursorAtEndOfLine: this._boolToNum(isCursorAtEndOfLine),
				debounceTime,
				artificialDelay,
				fetchStartedAfterMs,
				ttft: ttft_,
				fetchTime: fetchTime_,
				promptTokens: usage?.prompt_tokens,
				responseTokens: usage?.completion_tokens,
				cachedTokens: usage?.prompt_tokens_details.cached_tokens,
				acceptedPredictionTokens: usage?.completion_tokens_details?.accepted_prediction_tokens,
				rejectedPredictionTokens: usage?.completion_tokens_details?.rejected_prediction_tokens,
				hasNextEdit: this._boolToNum(hasNextEdit),
				nextEditLogprob,
				hadDiagnosticsNES: this._boolToNum(hadDiagnosticsNES),
				hadLlmNES: this._boolToNum(hadLlmNES),
				configIsDiagnosticsNESEnabled: this._boolToNum(configIsDiagnosticsNESEnabled),
				isNaturalLanguageDominated: this._boolToNum(isNaturalLanguageDominated),
				diagnosticHasExistingSameFileImport: this._boolToNum(diagnosticHasExistingSameFileImport),
				diagnosticIsLocalImport: this._boolToNum(diagnosticIsLocalImport),
				diagnosticAlternativeImportsCount: diagnosticAlternativeImportsCount,
				diagnosticDistanceToUnknownDiagnostic: diagnosticDistanceToUnknownDiagnostic,
				diagnosticDistanceToAlternativeDiagnostic: diagnosticDistanceToAlternativeDiagnostic,
				diagnosticHasAlternativeDiagnosticForSameRange: this._boolToNum(diagnosticHasAlternativeDiagnosticForSameRange)
			}
		);
	}

	private _sendTelemetryToBoth(properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this._telemetryService.sendMSFTTelemetryEvent('provideInlineEdit', properties, measurements);
		this._telemetryService.sendGHTelemetryEvent('copilot-nes/provideInlineEdit', properties, measurements);
	}

	private async _doSendEnhancedTelemetry(telemetry: INextEditProviderTelemetry): Promise<void> {

		const {
			opportunityId,
			headerRequestId,
			providerId,
			activeDocumentLanguageId,
			status: suggestionStatus,
			prompt,
			response,
			alternativeAction,
			postProcessingOutcome,
			activeDocumentRepository,
			repositoryUrls,
		} = telemetry;

		const modelResponse = response === undefined ? response : await response;

		this._telemetryService.sendEnhancedGHTelemetryEvent('copilot-nes/provideInlineEdit',
			multiplexProperties({
				opportunityId,
				headerRequestId,
				providerId,
				activeDocumentLanguageId,
				suggestionStatus,
				prompt,
				modelResponse: modelResponse === undefined || modelResponse.response.type !== ChatFetchResponseType.Success ? undefined : modelResponse.response.value,
				alternativeAction: alternativeAction ? JSON.stringify(alternativeAction) : undefined,
				postProcessingOutcome,
				activeDocumentRepository,
				repositories: JSON.stringify(repositoryUrls),
			})
		);
	}

	/**
	 * If `value` is undefined, return undefined, otherwise return 1 if `value` is true, 0 otherwise.
	 */
	private _boolToNum(value: boolean | undefined): number | undefined {
		return value === undefined ? undefined : (value ? 1 : 0);
	}

	dispose(): void {
		for (const { timeout } of this._map.values()) {
			clearTimeout(timeout);
		}

		this._map.clear();
	}
}
