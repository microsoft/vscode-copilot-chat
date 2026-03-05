/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from 'csv-parse';
import * as fs from 'fs/promises';
import { IAlternativeAction } from '../../src/extension/inlineEdits/node/nextEditProviderTelemetry';

/**
 * Represents one row from the Kusto export CSV with direct columns:
 *   suggestion_status, alternative_action, prompt, model_response,
 *   post_processing_outcome, active_document_language_id
 */
export interface ITelemetryRow {
	readonly suggestionStatus: string;
	readonly alternativeAction: IAlternativeAction;
	readonly prompt: unknown[];
	readonly modelResponse: string;
	readonly postProcessingOutcome: {
		suggestedEdit: string;
		isInlineCompletion: boolean;
	};
	readonly activeDocumentLanguageId: string;
}

/**
 * Parse a Kusto-exported CSV with 6 direct columns into structured rows.
 * Returns successfully parsed rows and a list of errors for failed rows.
 */
export async function parseTelemetryCsv(csvContents: string): Promise<{
	rows: ITelemetryRow[];
	errors: { rowIndex: number; error: string }[];
}> {
	const options = {
		columns: true as const,
		delimiter: ',',
		quote: '"',
		escape: '"',
		skip_empty_lines: true,
		trim: true,
		relax_quotes: true,
		bom: true,
		cast: false,
	} as const;

	type CsvRecord = Record<string, string>;

	const records = await new Promise<CsvRecord[]>((resolve, reject) =>
		parse<CsvRecord>(csvContents, options, (err, result) => {
			if (err) {
				reject(err);
			} else {
				resolve(result);
			}
		})
	);

	const rows: ITelemetryRow[] = [];
	const errors: { rowIndex: number; error: string }[] = [];

	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		try {
			// Validate required columns exist
			const requiredCols = [
				'suggestion_status',
				'alternative_action',
				'prompt',
				'model_response',
				'post_processing_outcome',
				'active_document_language_id',
			];
			for (const col of requiredCols) {
				if (!(col in record)) {
					throw new Error(`Missing column: ${col}`);
				}
			}

			// Parse JSON fields
			const alternativeAction = JSON.parse(record['alternative_action']) as IAlternativeAction;
			const prompt = JSON.parse(record['prompt']) as unknown[];
			const postProcessingOutcome = JSON.parse(record['post_processing_outcome']) as {
				suggestedEdit: string;
				isInlineCompletion: boolean;
			};

			// Validate critical fields
			if (!alternativeAction.recording) {
				throw new Error('alternativeAction.recording is missing');
			}
			if (!alternativeAction.recording.entries || alternativeAction.recording.entries.length === 0) {
				throw new Error('alternativeAction.recording.entries is empty');
			}
			if (!postProcessingOutcome.suggestedEdit) {
				throw new Error('postProcessingOutcome.suggestedEdit is missing');
			}

			rows.push({
				suggestionStatus: record['suggestion_status'],
				alternativeAction,
				prompt,
				modelResponse: record['model_response'],
				postProcessingOutcome,
				activeDocumentLanguageId: record['active_document_language_id'],
			});
		} catch (e) {
			errors.push({
				rowIndex: i,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return { rows, errors };
}

/**
 * Print a diagnostic summary of parsed rows.
 */
export function printDiagnostics(rows: ITelemetryRow[], errors: { rowIndex: number; error: string }[]): void {
	console.log('=== CSV Parse Results ===');
	console.log(`Total rows parsed: ${rows.length}`);
	console.log(`Errors: ${errors.length}`);

	if (errors.length > 0) {
		console.log('\n--- Errors ---');
		for (const err of errors) {
			console.log(`  Row ${err.rowIndex}: ${err.error}`);
		}
	}

	if (rows.length === 0) {
		return;
	}

	console.log('\n--- Per-Row Summary ---');
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const rec = row.alternativeAction.recording!;
		const entries = rec.entries;
		const entryCount = entries?.length ?? 0;

		// Count document types in recording
		const docIds = new Set<number>();
		let editCount = 0;
		if (entries) {
			for (const entry of entries) {
				if ('id' in entry) {
					docIds.add((entry as { id: number }).id);
				}
				if (entry.kind === 'changed') {
					editCount++;
				}
			}
		}

		console.log(`  Row ${i}: lang=${row.activeDocumentLanguageId}, status=${row.suggestionStatus}`);
		console.log(`    recording: ${entryCount} entries, ${docIds.size} docs, ${editCount} edits, requestTime=${rec.requestTime}`);
		console.log(`    altAction: textLen=${row.alternativeAction.textLength}, edits=${row.alternativeAction.edits.length}, tags=[${row.alternativeAction.tags.join(',')}]`);
		console.log(`    prompt: ${row.prompt.length} messages, ${JSON.stringify(row.prompt).length} chars`);
		console.log(`    modelResponse: ${row.modelResponse.length} chars`);
		console.log(`    postProcessingOutcome: ${row.postProcessingOutcome.suggestedEdit.substring(0, 60)}...`);
	}

	// Aggregate stats
	console.log('\n--- Aggregate Stats ---');
	const languages = new Map<string, number>();
	let totalEntries = 0;
	let totalEdits = 0;
	for (const row of rows) {
		languages.set(row.activeDocumentLanguageId, (languages.get(row.activeDocumentLanguageId) ?? 0) + 1);
		totalEntries += row.alternativeAction.recording!.entries?.length ?? 0;
		totalEdits += row.alternativeAction.edits.length;
	}
	console.log(`  Languages: ${[...languages.entries()].map(([k, v]) => `${k}(${v})`).join(', ')}`);
	console.log(`  Avg recording entries: ${Math.round(totalEntries / rows.length)}`);
	console.log(`  Avg altAction edits: ${Math.round(totalEdits / rows.length)}`);
}

/**
 * Read a CSV file and parse it into telemetry rows.
 */
export async function loadAndParseCsv(csvPath: string): Promise<{
	rows: ITelemetryRow[];
	errors: { rowIndex: number; error: string }[];
}> {
	const csvContents = await fs.readFile(csvPath, 'utf8');
	console.log(`Read ${csvContents.length} chars from ${csvPath}`);
	return parseTelemetryCsv(csvContents);
}
