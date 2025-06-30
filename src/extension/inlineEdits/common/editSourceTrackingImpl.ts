/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ArcTracker } from '../../../platform/editSurvivalTracking/common/arcTracker';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import { IObservableDocument, ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { sum } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { compareBy, numberComparator, reverseOrder } from '../../../util/vs/base/common/arrays';
import { IntervalTimer, TimeoutTimer } from '../../../util/vs/base/common/async';
import { Disposable, DisposableStore, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { derived, IObservable, IObservableWithChange, IReader, mapObservableArrayCached, observableSignal, observableValue, runOnChange, transaction } from '../../../util/vs/base/common/observableInternal';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { AnnotatedStringEdit, BaseStringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { createTimeout } from './common';
import { CombineStreamedChanges, DocumentWithAnnotatedEdits, EditReasonData, EditSource, EditSourceData, IDocumentWithAnnotatedEdits, MinimizeEditsProcessor } from './documentWithAnnotatedEdits';
import { DocumentEditSourceTracker, TrackedEdit } from './editTracker';

export class EditSourceTrackingImpl extends Disposable {
	public readonly docsState = mapObservableArrayCached(this, this._workspace.openDocuments, (doc, store) => {
		const docIsVisible = derived(reader => this._docIsVisible(doc, reader));
		return [doc, store.add(this._instantiationService.createInstance(TrackedDocumentInfo, doc, docIsVisible))] as const;
	}).recomputeInitiallyAndOnChange(this._store).map(entries => new Map(entries));

	constructor(
		private readonly _workspace: ObservableWorkspace,
		private readonly _docIsVisible: (doc: IObservableDocument, reader: IReader) => boolean,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
	}
}

class TrackedDocumentInfo extends Disposable {
	public readonly longtermTracker: IObservable<DocumentEditSourceTracker<undefined> | undefined>;
	public readonly windowedTracker: IObservable<DocumentEditSourceTracker<undefined> | undefined>;

	private readonly _repo: Promise<RepoContext | undefined>;

	constructor(
		private readonly _doc: IObservableDocument,
		docIsVisible: IObservable<boolean>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IGitService private readonly _gitService: IGitService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
		super();

		// Use the listener service and special events from core to annotate where an edit came from (is async)
		let processedDoc: IDocumentWithAnnotatedEdits<EditReasonData> = this._store.add(new DocumentWithAnnotatedEdits(_doc));
		// Combine streaming edits into one and make edit smaller
		processedDoc = this._store.add(this._instantiationService.createInstance((CombineStreamedChanges<EditReasonData>), processedDoc));
		// Remove common suffix and prefix from edits
		processedDoc = this._store.add(new MinimizeEditsProcessor(processedDoc));

		const docWithJustReason = createDocWithJustReason(processedDoc, this._store);

		this._store.add(this._instantiationService.createInstance(ArcTelemetrySender, processedDoc));

		const longtermResetSignal = observableSignal('resetSignal');

		this.longtermTracker = derived((reader) => {
			longtermResetSignal.read(reader);

			const t = reader.store.add(new DocumentEditSourceTracker(docWithJustReason, undefined));
			reader.store.add(toDisposable(() => {
				// send long term document telemetry
				if (!t.isEmpty()) {
					this.sendTelemetry('longterm', t.getTrackedRanges());
				}
				t.dispose();
			}));
			return t;
		}).recomputeInitiallyAndOnChange(this._store);

		this._store.add(new IntervalTimer()).cancelAndSet(() => {
			// Reset after 10 hours
			longtermResetSignal.trigger(undefined);
		}, 10 * 60 * 60 * 1000);

		(async () => {
			await this._gitService.initialize();
			const repo = await this._gitService.getRepository(_doc.id.toUri());
			if (!repo) { return; }
			if (this._store.isDisposed) {
				return;
			}
			// Reset on branch change or commit
			this._store.add(runOnChange(repo.headCommitHashObs, () => {
				longtermResetSignal.trigger(undefined);
			}));
			this._store.add(runOnChange(repo.headBranchNameObs, () => {
				longtermResetSignal.trigger(undefined);
			}));
		})();

		const resetSignal = observableSignal('resetSignal');

		// TODO: Implement rolling window!
		this.windowedTracker = derived((reader) => {
			if (!docIsVisible.read(reader)) {
				return undefined;
			}
			resetSignal.read(reader);

			reader.store.add(createTimeout(5 * 60 * 1000, () => {
				// Reset after 5 minutes
				resetSignal.trigger(undefined);
			}));

			const t = reader.store.add(new DocumentEditSourceTracker(docWithJustReason, undefined));
			reader.store.add(toDisposable(async () => {
				// send long term document telemetry
				this.sendTelemetry('5minWindow', t.getTrackedRanges());
				t.dispose();
			}));

			return t;
		}).recomputeInitiallyAndOnChange(this._store);

		this._repo = this._gitService.initialize().then(() => this._gitService.getRepository(_doc.id.toUri()));
	}

	async sendTelemetry(mode: 'longterm' | '5minWindow', ranges: readonly TrackedEdit[]) {
		if (ranges.length === 0) {
			return;
		}

		const data = this.getTelemetryData(ranges);
		const isTrackedByGit = await data.isTrackedByGit;

		const statsUuid = generateUuid();

		/* __GDPR__
			"editSourceTracker.stats" : {
				"owner": "hediet",
				"comment": "Reports distribution of AI vs user edited characters.",

				"mode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "longterm or 5minWindow" },
				"languageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The language id of the document." },
				"statsUuid": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The unique identifier for the telemetry event." },

				"nesModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of nes modified characters", "isMeasurement": true },
				"inlineCompletionsCopilotModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of inline completions copilot modified characters", "isMeasurement": true },
				"inlineCompletionsNESModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of inline completions nes modified characters", "isMeasurement": true },
				"otherAIModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of other AI modified characters", "isMeasurement": true },
				"unknownModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of unknown modified characters", "isMeasurement": true },
				"userModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of user modified characters", "isMeasurement": true },
				"ideModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of IDE modified characters", "isMeasurement": true },
				"totalModifiedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total modified characters", "isMeasurement": true },
				"isTrackedByGit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the document is tracked by git." }
			}
		*/
		this._telemetryService.sendTelemetryEvent<IEditSourceTrackerStatsEvent>('editSourceTracker.stats', { microsoft: true, github: { eventNamePrefix: 'copilot-nes/' } }, {
			mode,
			languageId: this._doc.languageId.get(),
			statsUuid: statsUuid,
		}, {
			nesModifiedCount: data.nesModifiedCount,
			inlineCompletionsCopilotModifiedCount: data.inlineCompletionsCopilotModifiedCount,
			inlineCompletionsNESModifiedCount: data.inlineCompletionsNESModifiedCount,
			otherAIModifiedCount: data.otherAIModifiedCount,
			unknownModifiedCount: data.unknownModifiedCount,
			userModifiedCount: data.userModifiedCount,
			ideModifiedCount: data.ideModifiedCount,
			totalModifiedCharacters: data.totalModifiedCharactersInFinalState,
			externalModifiedCount: data.externalModifiedCount,
			isTrackedByGit: isTrackedByGit ? 1 : 0,
		});


		const sums = sumByCategory(ranges, r => r.range.length, r => r.sourceKey);
		const entries = Object.entries(sums).filter(([key, value]) => value !== undefined);
		entries.sort(reverseOrder(compareBy(([key, value]) => value!, numberComparator)));
		entries.length = mode === 'longterm' ? 30 : 10;

		for (const [key, value] of Object.entries(sums)) {
			/* __GDPR__
				"editSourceTracker.details" : {
					"owner": "hediet",
					"comment": "Reports distribution of various edit kinds.",

					"reasonKey": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The reason for the edit." },
					"mode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "longterm or 5minWindow" },
					"languageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The language id of the document." },
					"statsUuid": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The unique identifier for the telemetry event." },

					"modifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Fraction of nes modified characters", "isMeasurement": true },
					"totalModifiedCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total number of characters", "isMeasurement": true }
				}
			*/
			this._telemetryService.sendTelemetryEvent('editSourceTracker.details', { microsoft: true, github: false }, {
				mode,
				reasonKey: key,
				languageId: this._doc.languageId.get(),
				statsUuid: statsUuid,
			}, {
				modifiedCount: value,
				totalModifiedCount: data.totalModifiedCharactersInFinalState,
			});
		}
	}

	getTelemetryData(ranges: readonly TrackedEdit[]) {
		const getEditCategory = (source: EditSource) => {
			if (source.category === 'ai' && source.kind === 'nes') { return 'nes'; }
			if (source.category === 'ai' && source.kind === 'completion' && source.extensionId === 'github.copilot') { return 'inlineCompletionsCopilot'; }
			if (source.category === 'ai' && source.kind === 'completion' && source.extensionId === 'github.copilot-chat') { return 'inlineCompletionsNES'; }
			if (source.category === 'ai' && source.kind === 'completion') { return 'inlineCompletionsOther'; }
			if (source.category === 'ai') { return 'otherAI'; }
			if (source.category === 'user') { return 'user'; }
			if (source.category === 'ide') { return 'ide'; }
			if (source.category === 'external') { return 'external'; }
			if (source.category === 'unknown') { return 'unknown'; }

			return 'unknown';
		};

		const sums = sumByCategory(ranges, r => r.range.length, r => getEditCategory(r.source));
		const totalModifiedCharactersInFinalState = sum(ranges, r => r.range.length);

		return {
			nesModifiedCount: sums.nes ?? 0,
			inlineCompletionsCopilotModifiedCount: sums.inlineCompletionsCopilot ?? 0,
			inlineCompletionsNESModifiedCount: sums.inlineCompletionsNES ?? 0,
			otherAIModifiedCount: sums.otherAI ?? 0,
			userModifiedCount: sums.user ?? 0,
			ideModifiedCount: sums.ide ?? 0,
			unknownModifiedCount: sums.unknown ?? 0,
			externalModifiedCount: sums.external ?? 0,
			totalModifiedCharactersInFinalState,
			languageId: this._doc.languageId.get(),
			isTrackedByGit: this._repo.then(async (repo) => !!repo && !await repo.isIgnored(this._doc.id.toUri())),
		};
	}
}

declare global {
	interface TelemetryEventMap {
		IEditSourceTrackerStatsEvent: IEditSourceTrackerStatsEvent;
	}
}

interface IEditSourceTrackerStatsEvent {
	eventName: 'editSourceTracker.stats';
	properties: {
		mode: string;
		languageId: string;
		statsUuid: string;
	};
	measurements: {
		nesModifiedCount: number;
		inlineCompletionsCopilotModifiedCount: number;
		inlineCompletionsNESModifiedCount: number;
		otherAIModifiedCount: number;
		unknownModifiedCount: number;
		userModifiedCount: number;
		ideModifiedCount: number;
		totalModifiedCharacters: number;
		externalModifiedCount: number;
		isTrackedByGit: number;
	};
}

function mapObservableDelta<T, TDelta, TDeltaNew>(obs: IObservableWithChange<T, TDelta>, mapFn: (value: TDelta) => TDeltaNew, store: DisposableStore): IObservableWithChange<T, TDeltaNew> {
	const obsResult = observableValue<T, TDeltaNew>('mapped', obs.get());
	store.add(runOnChange(obs, (value, _prevValue, changes) => {
		transaction(tx => {
			for (const c of changes) {
				obsResult.set(value, tx, mapFn(c));
			}
		});
	}));
	return obsResult;
}

/**
 * Removing the metadata allows touching edits from the same source to merged, even if they were caused by different actions (e.g. two user edits).
 */
function createDocWithJustReason(docWithAnnotatedEdits: IDocumentWithAnnotatedEdits<EditReasonData>, store: DisposableStore): IDocumentWithAnnotatedEdits<EditSourceData> {
	const docWithJustReason: IDocumentWithAnnotatedEdits<EditSourceData> = {
		value: mapObservableDelta(docWithAnnotatedEdits.value, edit => ({ edit: edit.edit.mapData(d => d.data.toEditSourceData()) }), store),
		waitForQueue: () => docWithAnnotatedEdits.waitForQueue(),
	};
	return docWithJustReason;
}

class ArcTelemetrySender extends Disposable {
	constructor(
		docWithAnnotatedEdits: IDocumentWithAnnotatedEdits<EditReasonData>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		this._register(runOnChange(docWithAnnotatedEdits.value, (_val, _prev, changes) => {
			const edit = AnnotatedStringEdit.compose(changes.map(c => c.edit));
			if (edit.replacements.length !== 1) {
				return;
			}
			const singleEdit = edit.replacements[0];
			const data = singleEdit.data.editReason.metadata;
			if (data?.source !== 'inlineCompletionAccept') {
				return;
			}

			const docWithJustReason = createDocWithJustReason(docWithAnnotatedEdits, this._store);
			const reporter = this._instantiationService.createInstance(EditTelemetryReporter, docWithJustReason, singleEdit.toEdit(), res => {
				/* __GDPR__
					"reportInlineEditArc" : {
						"owner": "hediet",
						"comment": "Reports the accepted and retained character count for an inline completion/edit.",
						"extensionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The extension id (copilot or copilot-chat), which provided this inline completion." },
						"opportunityId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Unique identifier for an opportunity to show an inline completion or NES." },

						"didBranchChange": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Indicates if the branch changed in the meantime. If the branch changed (value is 1), this event should probably be ignored." },
						"timeDelayMs": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time delay between the user accepting the edit and measuring the survival rate." },
						"arc": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The accepted and restrained character count." },
						"originalCharCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The original character count before any edits." }
					}
				*/
				res.telemetryService.sendTelemetryEvent<IReportInlineEditArcEvent>('reportInlineEditArc', { microsoft: true, github: { eventNamePrefix: 'copilot-nes/' } },
					{
						extensionId: data.$extensionId ?? '',
						opportunityId: data.$$requestUuid ?? 'unknown',
					},
					{
						didBranchChange: res.didBranchChange ? 1 : 0,
						timeDelayMs: res.timeDelayMs,
						arc: res.arc,
						originalCharCount: res.originalCharCount,
					}
				);
			});

			this._register(toDisposable(() => {
				reporter.cancel();
			}));
		}));
	}
}

declare global {
	interface TelemetryEventMap {
		IReportInlineEditArcEvent: IReportInlineEditArcEvent;
	}
}

interface IReportInlineEditArcEvent {
	eventName: 'reportInlineEditArc';
	properties: {
		extensionId: string;
		opportunityId: string;
	};
	measurements: {
		didBranchChange: number;
		timeDelayMs: number;
		arc: number;
		originalCharCount: number;
	};
}

export interface EditTelemetryData {
	telemetryService: ITelemetryService;
	timeDelayMs: number;
	didBranchChange: boolean;
	arc: number;
	originalCharCount: number;
}

export class EditTelemetryReporter {
	private readonly _store = new DisposableStore();
	private readonly _arcTracker;
	private readonly _initialBranchName: string | undefined;

	constructor(
		private readonly _document: { value: IObservableWithChange<StringText, { edit: BaseStringEdit }> },
		// _markedEdits -> document.value
		private readonly _trackedEdit: BaseStringEdit,
		private readonly _sendTelemetryEvent: (res: EditTelemetryData) => void,

		@IGitService private readonly _gitService: IGitService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
		this._arcTracker = new ArcTracker(this._document.value.get().value, this._trackedEdit);

		this._store.add(runOnChange(this._document.value, (_val, _prevVal, changes) => {
			const edit = BaseStringEdit.composeOrUndefined(changes.map(c => c.edit));
			if (edit) {
				this._arcTracker.handleEdits(edit);
			}
		}));

		this._initialBranchName = this._gitService.activeRepository.get()?.headBranchName;

		// This aligns with github inline completions
		this._reportAfter(30 * 1000);
		this._reportAfter(120 * 1000);
		this._reportAfter(300 * 1000);
		this._reportAfter(600 * 1000);
		// track up to 15min to allow for slower edit responses from legacy SD endpoint
		this._reportAfter(900 * 1000, () => {
			this._store.dispose();
		});
	}

	private _getCurrentBranchName() {
		return this._gitService.activeRepository.get()?.headBranchName;
	}

	private _reportAfter(timeoutMs: number, cb?: () => void) {
		const timer = new TimeoutTimer(() => {
			this._report(timeoutMs);
			timer.dispose();
			if (cb) {
				cb();
			}
		}, timeoutMs);
		this._store.add(timer);
	}

	private _report(timeMs: number): void {
		const currentBranch = this._getCurrentBranchName();
		const didBranchChange = currentBranch !== this._initialBranchName;

		this._sendTelemetryEvent({
			telemetryService: this._telemetryService,
			timeDelayMs: timeMs,
			didBranchChange,
			arc: this._arcTracker.getAcceptedRestrainedCharactersCount(),
			originalCharCount: this._arcTracker.getOriginalCharacterCount(),
		});
	}

	public cancel(): void {
		this._store.dispose();
	}
}

function sumByCategory<T, TCategory extends string>(items: readonly T[], getValue: (item: T) => number, getCategory: (item: T) => TCategory): Record<TCategory, number | undefined> {
	return items.reduce((acc, item) => {
		const category = getCategory(item);
		acc[category] = (acc[category] || 0) + getValue(item);
		return acc;
	}, {} as Record<TCategory, number>);
}
