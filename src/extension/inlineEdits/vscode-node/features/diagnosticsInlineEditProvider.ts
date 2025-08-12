/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../../../platform/inlineEdits/common/observableGit';
import { ShowNextEditPreference } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import * as errors from '../../../../util/common/errors';
import { createTracer, ITracer } from '../../../../util/common/tracing';
import { timeout } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { BugIndicatingError } from '../../../../util/vs/base/common/errors';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { StringReplacement } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { INextEditProvider } from '../../node/nextEditProvider';
import { DiagnosticsTelemetryBuilder } from '../../node/nextEditProviderTelemetry';
import { INextEditDisplayLocation, INextEditResult } from '../../node/nextEditResult';
import { VSCodeWorkspace } from '../parts/vscodeWorkspace';
import { DiagnosticCompletionItem } from './diagnosticsBasedCompletions/diagnosticsCompletions';
import { DiagnosticCompletionState, DiagnosticsCompletionProcessor } from './diagnosticsCompletionProcessor';

export class DiagnosticsNextEditResult implements INextEditResult {
	constructor(
		public readonly requestId: number,
		public readonly result: {
			edit: StringReplacement;
			displayLocation?: INextEditDisplayLocation;
			item: DiagnosticCompletionItem;
			showRangePreference?: ShowNextEditPreference;
		} | undefined,
	) { }
}

export class DiagnosticsNextEditProvider extends Disposable implements INextEditProvider<DiagnosticsNextEditResult, DiagnosticsTelemetryBuilder, boolean> {
	public readonly ID = 'DiagnosticsNextEditProvider';

	private _lastRejectionTime: number = 0;
	public get lastRejectionTime(): number {
		return this._lastRejectionTime;
	}

	private _lastTriggerTime: number = 0;
	public get lastTriggerTime(): number {
		return this._lastTriggerTime;
	}

	private readonly _diagnosticsCompletionHandler: DiagnosticsCompletionProcessor;
	private _tracer: ITracer;

	constructor(
		workspace: VSCodeWorkspace,
		git: ObservableGit,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super();

		this._tracer = createTracer(['NES', 'DiagnosticsNextEditProvider'], (s) => logService.trace(s));
		this._diagnosticsCompletionHandler = this._register(instantiationService.createInstance(DiagnosticsCompletionProcessor, workspace, git));
	}

	async getNextEdit(docId: DocumentId, context: vscode.InlineCompletionContext, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken, tb: DiagnosticsTelemetryBuilder): Promise<DiagnosticsNextEditResult> {
		this._lastTriggerTime = Date.now();

		if (cancellationToken.isCancellationRequested) {
			this._tracer.trace('cancellationRequested before started');
			return new DiagnosticsNextEditResult(logContext.requestId, undefined);
		}

		let diagnosticEditResult = this._diagnosticsCompletionHandler.getCurrentState(docId);
		if (!diagnosticEditResult.item) {
			diagnosticEditResult = await this._diagnosticsCompletionHandler.getNextUpdatedState(docId, cancellationToken);
		}

		return this._createNextEditResult(diagnosticEditResult, logContext, tb);
	}

	async runUntilNextEdit(docId: DocumentId, context: vscode.InlineCompletionContext, logContext: InlineEditRequestLogContext, delayStart: number, cancellationToken: CancellationToken, tb: DiagnosticsTelemetryBuilder): Promise<DiagnosticsNextEditResult> {
		try {
			await timeout(delayStart);
			if (cancellationToken.isCancellationRequested) {
				this._tracer.trace('cancellationRequested before started');
				return new DiagnosticsNextEditResult(logContext.requestId, undefined);
			}

			// Check if the last computed edit is still valid
			let completionResult = this._diagnosticsCompletionHandler.getCurrentState(docId);
			let telemetry = new DiagnosticsTelemetryBuilder();
			let diagnosticEditResult = this._createNextEditResult(completionResult, logContext, telemetry);

			// If the last computed edit is not valid, wait until the state is updated or the operation is cancelled
			while (!diagnosticEditResult.result && !cancellationToken.isCancellationRequested) {
				completionResult = await this._diagnosticsCompletionHandler.getNextUpdatedState(docId, cancellationToken);
				telemetry = new DiagnosticsTelemetryBuilder();
				diagnosticEditResult = this._createNextEditResult(completionResult, logContext, telemetry);
			}

			telemetry.populate(tb);

			// TODO: Better incorporate diagnostics logging
			if (completionResult.logContext) {
				completionResult.logContext.getLogs().forEach(log => logContext.addLog(log));
			}

			return diagnosticEditResult;
		} catch (error) {
			const errorMessage = `Error occurred while waiting for diagnostic edit: ${errors.toString(errors.fromUnknown(error))}`;
			logContext.addLog(errorMessage);
			this._tracer.trace(errorMessage);
			return new DiagnosticsNextEditResult(logContext.requestId, undefined);
		}
	}

	private _createNextEditResult(diagnosticEditResult: DiagnosticCompletionState, logContext: InlineEditRequestLogContext, tb: DiagnosticsTelemetryBuilder): DiagnosticsNextEditResult {
		const { item, telemetry } = diagnosticEditResult;

		// Diagnostics might not have updated yet since accepting a diagnostics based NES
		if (item && this._hasRecentlyBeenAccepted(item)) {
			tb.addDroppedReason(`${item.type}:recently-accepted`);
			this._tracer.trace('recently accepted');
			return new DiagnosticsNextEditResult(logContext.requestId, undefined);
		}

		telemetry.droppedReasons.forEach(reason => tb.addDroppedReason(reason));
		tb.setDiagnosticRunTelemetry(telemetry);

		if (!item) {
			this._tracer.trace('no diagnostic edit result');
			return new DiagnosticsNextEditResult(logContext.requestId, undefined);
		}

		tb.setType(item.type);
		logContext.setDiagnosticsResult(item.getRootedLineEdit());

		this._tracer.trace(`created next edit result`);

		return new DiagnosticsNextEditResult(logContext.requestId, {
			edit: item.toOffsetEdit(),
			displayLocation: item.nextEditDisplayLocation,
			item
		});
	}

	handleShown(suggestion: DiagnosticsNextEditResult): void { }

	handleAcceptance(docId: DocumentId, suggestion: DiagnosticsNextEditResult): void {
		const completionResult = suggestion.result;
		if (!completionResult) {
			throw new BugIndicatingError('Completion result is undefined when accepted');
		}

		this._lastAcceptedItem = { item: completionResult.item, time: Date.now() };
		this._diagnosticsCompletionHandler.handleEndOfLifetime(completionResult.item, { kind: vscode.InlineCompletionEndOfLifeReasonKind.Accepted });
	}

	private _lastAcceptedItem: { item: DiagnosticCompletionItem; time: number } | undefined = undefined;
	private _hasRecentlyBeenAccepted(item: DiagnosticCompletionItem): boolean {
		if (!this._lastAcceptedItem) {
			return false;
		}

		if (Date.now() - this._lastAcceptedItem.time >= 1000) {
			return false;
		}

		return item.diagnostic.equals(this._lastAcceptedItem.item.diagnostic) || DiagnosticCompletionItem.equals(this._lastAcceptedItem.item, item);
	}

	handleRejection(docId: DocumentId, suggestion: DiagnosticsNextEditResult): void {
		this._lastRejectionTime = Date.now();

		const completionResult = suggestion.result;
		if (!completionResult) {
			throw new BugIndicatingError('Completion result is undefined when rejected');
		}

		this._diagnosticsCompletionHandler.handleEndOfLifetime(completionResult.item, { kind: vscode.InlineCompletionEndOfLifeReasonKind.Rejected });
	}

	handleIgnored(docId: DocumentId, suggestion: DiagnosticsNextEditResult, supersededBy: INextEditResult | undefined): void {
		const completionResult = suggestion.result;
		if (!completionResult) {
			throw new BugIndicatingError('Completion result is undefined when accepted');
		}

		const supersededByItem = supersededBy instanceof DiagnosticsNextEditResult ? supersededBy?.result?.item : undefined;

		this._diagnosticsCompletionHandler.handleEndOfLifetime(completionResult.item, {
			kind: vscode.InlineCompletionEndOfLifeReasonKind.Ignored,
			supersededBy: supersededByItem,
			userTypingDisagreed: false /* TODO: Adopt this*/
		});
	}

}
