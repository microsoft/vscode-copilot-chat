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
	/** The replayer — caller must dispose when done */
	readonly replayer: ObservableWorkspaceRecordingReplayer;
	/** The reconstructed workspace at request time */
	readonly workspace: MutableObservableWorkspace;
	/** The document that was active when the NES request was made */
	readonly activeDocId: DocumentId;
	/** The active document observable */
	readonly activeDocument: IObservableDocument;
	/** Relative path of the active file */
	readonly activeFilePath: string;
	/** The oracle: what the user actually typed next (from post-request recording) */
	readonly nextUserEdit: {
		readonly edit: readonly (readonly [start: number, endEx: number, text: string])[];
		readonly relativePath: string;
		readonly originalOpIdx: number;
	};
	/** The recording information (pre-request log + oracle) for downstream consumers */
	readonly recordingInfo: IRecordingInformation;
}

/**
 * Parse a suggestedEdit string like "[978, 1021) -> \"foo\"" into [start, endEx, text].
 * Replicates the logic from script/alternativeAction/index.ts.
 */
function parseSuggestedEdit(suggestedEditStr: string): [number, number, string] | null {
	const [stringifiedRange, quotedText] = suggestedEditStr.split(' -> ');
	const match = stringifiedRange.match(/^\[(\d+), (\d+)\)$/);
	if (match) {
		const start = parseInt(match[1], 10);
		const endEx = parseInt(match[2], 10);
		const text = quotedText.slice(1, -1); // Remove surrounding quotes
		return [start, endEx, text];
	}
	return null;
}

/**
 * Process a single telemetry row:
 * 1. Split recording at request time, extract oracle edit (via Processor)
 * 2. Replay pre-request recording via ObservableWorkspaceRecordingReplayer
 * 3. Return workspace state + oracle for downstream prompt generation
 */
export function processRow(row: ITelemetryRow): IProcessedRow | { error: string } {
	try {
		return _processRow(row);
	} catch (e) {
		return { error: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

function _processRow(row: ITelemetryRow): IProcessedRow | { error: string } {
	// Step 1: Use Processor to split recording and extract oracle
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

	// Step 2: Replay the pre-request recording to reconstruct workspace
	const recordingInfo: IRecordingInformation = {
		log: recording.log,
		nextUserEdit: recording.nextUserEdit ? {
			relativePath: recording.nextUserEdit.relativePath,
			edit: recording.nextUserEdit.edit,
		} : undefined,
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

	// Determine active file path from the scoring edits
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
 * Process all telemetry rows, returning successfully processed rows and errors.
 * NOTE: Each returned IProcessedRow holds a live replayer that must be disposed by the caller.
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

/**
 * Print a diagnostic summary of replayed rows.
 */
export function printReplayDiagnostics(
	processed: readonly IProcessedRow[],
	errors: readonly { rowIndex: number; error: string }[],
): void {
	console.log('\n=== Recording Replay Results ===');
	console.log(`Successfully replayed: ${processed.length}`);
	console.log(`Replay errors: ${errors.length}`);

	if (errors.length > 0) {
		console.log('\n--- Replay Errors ---');
		for (const err of errors) {
			console.log(`  Row ${err.rowIndex}: ${err.error}`);
		}
	}

	if (processed.length === 0) {
		return;
	}

	console.log('\n--- Replayed Workspace Summary ---');
	for (let i = 0; i < Math.min(processed.length, 10); i++) {
		const p = processed[i];
		const docs = p.workspace.openDocuments.get();
		const activeValue = p.activeDocument.value.get().value;
		const oracleEdits = p.nextUserEdit?.edit?.length ?? 0;

		console.log(`  Row ${i}: file=${p.activeFilePath}, lang=${p.row.activeDocumentLanguageId}`);
		console.log(`    workspace: ${docs.length} documents`);
		console.log(`    activeDoc: ${activeValue.length} chars`);
		console.log(`    oracleEdits: ${oracleEdits} replacements`);
	}

	if (processed.length > 10) {
		console.log(`  ... and ${processed.length - 10} more rows`);
	}

	// Aggregate
	let totalDocs = 0;
	let totalOracleEdits = 0;
	for (const p of processed) {
		totalDocs += p.workspace.openDocuments.get().length;
		totalOracleEdits += p.nextUserEdit?.edit?.length ?? 0;
	}
	console.log(`\n--- Replay Aggregate Stats ---`);
	console.log(`  Avg documents per workspace: ${(totalDocs / processed.length).toFixed(1)}`);
	console.log(`  Avg oracle edits: ${(totalOracleEdits / processed.length).toFixed(1)}`);
}
