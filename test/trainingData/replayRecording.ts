/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRecordingInformation, ObservableWorkspaceRecordingReplayer } from '../../src/extension/inlineEdits/common/observableWorkspaceRecordingReplayer';
import { DocumentId } from '../../src/platform/inlineEdits/common/dataTypes/documentId';
import { IObservableDocument, MutableObservableWorkspace } from '../../src/platform/inlineEdits/common/observableWorkspace';
import { coalesce } from '../../src/util/vs/base/common/arrays';
import { Processor } from '../../script/alternativeAction/processor';
import { ITelemetryRow } from './parseCsv';

/**
 * Result of processing a single telemetry row: replayed workspace + oracle edit.
 */
export interface IProcessedRow {
	readonly row: ITelemetryRow;
	readonly replayer: ObservableWorkspaceRecordingReplayer;
	readonly workspace: MutableObservableWorkspace;
	readonly activeDocId: DocumentId;
	readonly activeDocument: IObservableDocument;
	readonly activeFilePath: string;
	/** What the user actually typed next (from post-request recording). */
	readonly nextUserEdit: {
		readonly edit: readonly (readonly [start: number, endEx: number, text: string])[];
		readonly relativePath: string;
		readonly originalOpIdx: number;
	};
	readonly recordingInfo: IRecordingInformation;
}

/**
 * Parse a suggestedEdit string like `[978, 1021) -> "foo"` into `[start, endEx, text]`.
 */
function parseSuggestedEdit(suggestedEditStr: string): [number, number, string] | null {
	const [stringifiedRange, quotedText] = suggestedEditStr.split(' -> ');
	const match = stringifiedRange.match(/^\[(\d+), (\d+)\)$/);
	if (match) {
		const start = parseInt(match[1], 10);
		const endEx = parseInt(match[2], 10);
		const text = quotedText.slice(1, -1);
		return [start, endEx, text];
	}
	return null;
}

/**
 * Process a single telemetry row: split recording at request time, replay
 * the pre-request portion and extract the oracle edit.
 */
export function processRow(row: ITelemetryRow): IProcessedRow | { error: string } {
	try {
		return _processRow(row);
	} catch (e) {
		return { error: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

function _processRow(row: ITelemetryRow): IProcessedRow | { error: string } {
	const proposedEdits = coalesce([parseSuggestedEdit(row.postProcessingOutcome.suggestedEdit)]);
	const isAccepted = row.suggestionStatus === 'accepted';

	const scoring = Processor.createScoringForAlternativeAction(
		row.alternativeAction,
		proposedEdits,
		isAccepted,
	);

	if (!scoring) {
		return { error: 'Processor.createScoringForAlternativeAction returned undefined' };
	}

	const recording = scoring.scoringContext.recording;

	const recordingInfo: IRecordingInformation = {
		log: recording.log,
		nextUserEdit: {
			relativePath: recording.nextUserEdit.relativePath,
			edit: recording.nextUserEdit.edit,
		},
	};

	const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);
	let lastDocId: DocumentId;
	try {
		const result = replayer.replay();
		lastDocId = result.lastDocId;
	} catch (e) {
		replayer.dispose();
		return { error: `Replay failed: ${e instanceof Error ? e.message : String(e)}` };
	}

	const workspace = replayer.workspace;
	const activeDocument = workspace.getDocument(lastDocId);
	if (!activeDocument) {
		replayer.dispose();
		return { error: `Active document not found after replay: ${lastDocId}` };
	}

	// Prefer scoring edit URI, fall back to oracle path
	const activeFilePath = scoring.edits[0]?.documentUri ?? recording.nextUserEdit?.relativePath ?? 'unknown';

	return {
		row,
		replayer,
		workspace,
		activeDocId: lastDocId,
		activeDocument,
		activeFilePath,
		nextUserEdit: recording.nextUserEdit,
		recordingInfo,
	};
}

/**
 * Process all telemetry rows.
 * Each returned `IProcessedRow` holds a live replayer that must be disposed by the caller.
 */
export function processAllRows(rows: readonly ITelemetryRow[]): {
	processed: IProcessedRow[];
	errors: { rowIndex: number; error: string }[];
} {
	const processed: IProcessedRow[] = [];
	const errors: { rowIndex: number; error: string }[] = [];

	for (let i = 0; i < rows.length; i++) {
		const result = processRow(rows[i]);
		if ('error' in result) {
			errors.push({ rowIndex: i, error: result.error });
		} else {
			processed.push(result);
		}
	}

	return { processed, errors };
}
