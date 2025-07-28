/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TextDocumentChangeReason, window } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { IStatelessNextEditProvider } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { NesHistoryContextProvider } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITracer, createTracer } from '../../../util/common/tracing';
import { Disposable, DisposableMap, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { IObservableSignal, observableSignal } from '../../../util/vs/base/common/observableInternal';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CompletionsProvider } from '../../completions/vscode-node/completionsProvider';
import { createNextEditProvider } from '../node/createNextEditProvider';
import { DebugRecorder } from '../node/debugRecorder';
import { NextEditProvider } from '../node/nextEditProvider';
import { DiagnosticsNextEditProvider } from './features/diagnosticsInlineEditProvider';
import { VSCodeWorkspace } from './parts/vscodeWorkspace';

const TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT = 10000; // 10 seconds
const TRIGGER_INLINE_EDIT_ON_SAME_LINE_COOLDOWN = 5000; // milliseconds
const TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN = 5000; // 5s

export class InlineEditModel extends Disposable {
	public readonly debugRecorder = this._register(new DebugRecorder(this.workspace));
	public readonly nextEditProvider: NextEditProvider;

	private readonly _predictor: IStatelessNextEditProvider;

	public readonly inlineEditsInlineCompletionsEnabled = this._configurationService.getConfigObservable(ConfigKey.Internal.InlineEditsInlineCompletionsEnabled);

	public readonly onChange = observableSignal(this);

	constructor(
		private readonly _predictorId: string | undefined,
		public readonly workspace: VSCodeWorkspace,
		historyContextProvider: NesHistoryContextProvider,
		public readonly diagnosticsBasedProvider: DiagnosticsNextEditProvider | undefined,
		public readonly completionsProvider: CompletionsProvider | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super();

		this._predictor = createNextEditProvider(this._predictorId, this._instantiationService);
		const xtabDiffNEntries = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsXtabDiffNEntries, this._expService);
		const xtabHistoryTracker = new NesXtabHistoryTracker(this.workspace, xtabDiffNEntries);
		this.nextEditProvider = this._instantiationService.createInstance(NextEditProvider, this.workspace, this._predictor, historyContextProvider, xtabHistoryTracker, this.debugRecorder);

		if (this._predictor.dependsOnSelection) {
			this._register(new InlineEditTriggerer(this.workspace, this.nextEditProvider, this.onChange, this._logService, this._configurationService, this._expService));
		}
	}
}

class LastChange extends Disposable {
	public lastEditedTimestamp: number;
	public lineNumberTriggers: Map<number /* lineNumber */, number /* timestamp */>;

	private _timeout: NodeJS.Timeout | undefined;
	public set timeout(value: NodeJS.Timeout | undefined) {
		if (value !== undefined) {
			// TODO: we can end up collecting multiple timeouts, but also they could be cleared as debouncing happens
			this._register(toDisposable(() => clearTimeout(value)));
		}
		this._timeout = value;
	}
	public get timeout(): NodeJS.Timeout | undefined {
		return this._timeout;
	}

	private _nConsecutiveSelectionChanges = 0;
	public get nConsequtiveSelectionChanges(): number {
		return this._nConsecutiveSelectionChanges;
	}
	public incrementSelectionChangeEventCount(): void {
		this._nConsecutiveSelectionChanges++;
	}

	constructor() {
		super();
		this.lastEditedTimestamp = Date.now();
		this.lineNumberTriggers = new Map();
		this.timeout = undefined;
	}
}

class InlineEditTriggerer extends Disposable {

	private readonly docToLastChangeMap = this._register(new DisposableMap<DocumentId, LastChange>());

	private readonly _tracer: ITracer;

	constructor(
		private readonly workspace: VSCodeWorkspace,
		private readonly nextEditProvider: NextEditProvider,
		private readonly onChange: IObservableSignal<void>,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
	) {
		super();

		this._tracer = createTracer(['NES', 'Triggerer'], (s) => this._logService.trace(s));

		this.registerListeners();
	}

	public registerListeners() {
		this._registerDocumentChangeListener();
		this._registerSelectionChangeListener();
	}

	private _shouldIgnoreDoc(doc: vscode.TextDocument): boolean {
		return doc.uri.scheme === 'output'; // ignore output pane documents
	}

	private _registerDocumentChangeListener() {
		this._store.add(this._register(vscode.workspace.onDidChangeTextDocument(e => {
			if (this._shouldIgnoreDoc(e.document)) {
				return;
			}

			const tracer = this._tracer.sub('onDidChangeTextDocument');

			if (e.reason === TextDocumentChangeReason.Undo || e.reason === TextDocumentChangeReason.Redo) { // ignore
				tracer.returns('undo/redo');
				return;
			}

			const doc = this.workspace.getDocumentByTextDocument(e.document);

			if (!doc) { // doc is likely copilot-ignored
				tracer.returns('ignored document');
				return;
			}

			this.docToLastChangeMap.set(doc.id, new LastChange());

			tracer.returns('setting last edited timestamp');
		})));
	}

	private _registerSelectionChangeListener() {
		this._store.add(this._register(window.onDidChangeTextEditorSelection((e) => {
			if (this._shouldIgnoreDoc(e.textEditor.document)) {
				return;
			}

			const tracer = this._tracer.sub('onDidChangeTextEditorSelection');

			if (e.selections.length !== 1) { // ignore multi-selection case
				tracer.returns('multiple selections');
				return;
			}

			if (!e.selections[0].isEmpty) { // ignore non-empty selection
				tracer.returns('not empty selection');
				return;
			}

			const doc = this.workspace.getDocumentByTextDocument(e.textEditor.document);
			if (!doc) { // doc is likely copilot-ignored
				return;
			}

			const now = Date.now();
			const timeSince = (timestamp: number) => now - timestamp;

			if (timeSince(this.nextEditProvider.lastRejectionTime) < TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN) {
				// the cursor has moved within 5s of the last rejection, don't auto-trigger until another doc modification
				this.docToLastChangeMap.deleteAndDispose(doc.id);
				tracer.returns('rejection cooldown');
				return;
			}

			const mostRecentChange = this.docToLastChangeMap.get(doc.id);
			if (!mostRecentChange) {
				tracer.returns('document not tracked - does not have recent changes');
				return;
			}

			const hasRecentEdit = timeSince(mostRecentChange.lastEditedTimestamp) < TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT;

			if (!hasRecentEdit) {
				tracer.returns('no recent edit');
				return;
			}

			const hasRecentTrigger = timeSince(this.nextEditProvider.lastTriggerTime) < TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT;
			if (!hasRecentTrigger) {
				// the provider was not triggered recently, so we might be observing a cursor change event following
				// a document edit caused outside of regular typing, otherwise the UI would have invoked us recently
				tracer.returns('no recent trigger');
				return;
			}

			const selectionLine = e.selections[0].active.line;
			const lastTriggerTimestampForLine = mostRecentChange.lineNumberTriggers.get(selectionLine);
			if (lastTriggerTimestampForLine !== undefined && timeSince(lastTriggerTimestampForLine) < TRIGGER_INLINE_EDIT_ON_SAME_LINE_COOLDOWN) {
				tracer.returns('same line cooldown');
				return;
			}

			// TODO: Do not trigger if there is an existing valid request now running, ie don't use just last-trigger timestamp

			// cleanup old triggers if too many
			if (mostRecentChange.lineNumberTriggers.size > 100) {
				for (const [lineNumber, timestamp] of mostRecentChange.lineNumberTriggers.entries()) {
					if (now - timestamp > TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT) {
						mostRecentChange.lineNumberTriggers.delete(lineNumber);
					}
				}
			}

			mostRecentChange.lineNumberTriggers.set(selectionLine, now);
			tracer.returns('triggering inline edit');

			const debounceOnSelectionChange = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsDebounceOnSelectionChange, this._expService);
			if (debounceOnSelectionChange === undefined) {
				this._triggerInlineEdit();
			} else {
				// this's 2 because first change is caused by the edit, 2nd one is potentially user intentionally to the next edit location
				// further events would be multiple consecutive selection changes that we want to debounce
				const N_ALLOWED_IMMEDIATE_SELECTION_CHANGE_EVENTS = 2;
				if (mostRecentChange.nConsequtiveSelectionChanges < N_ALLOWED_IMMEDIATE_SELECTION_CHANGE_EVENTS) {
					this._triggerInlineEdit();
				} else {
					if (mostRecentChange.timeout) {
						clearTimeout(mostRecentChange.timeout);
					}
					mostRecentChange.timeout = setTimeout(() => {
						mostRecentChange.timeout = undefined;
						this._triggerInlineEdit();
					}, debounceOnSelectionChange);
				}
				mostRecentChange.incrementSelectionChangeEventCount();
			}
		})));
	}

	private _triggerInlineEdit() {
		this.onChange.trigger(undefined);
	}
}
