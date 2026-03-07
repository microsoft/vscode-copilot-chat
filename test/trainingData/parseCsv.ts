/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from 'csv-parse';
import * as fs from 'fs/promises';
import { IAlternativeAction } from '../../src/extension/inlineEdits/node/nextEditProviderTelemetry';

/**
 * A single row from the Kusto NES telemetry export.
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

const requiredColumns = [
	'suggestion_status',
	'alternative_action',
	'prompt',
	'model_response',
	'post_processing_outcome',
	'active_document_language_id',
] as const;

/**
 * Parse a Kusto-exported CSV into structured telemetry rows.
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
			for (const col of requiredColumns) {
				if (!(col in record)) {
					throw new Error(`Missing column: ${col}`);
				}
			}

			const alternativeAction = JSON.parse(record['alternative_action']) as IAlternativeAction;
			const prompt = JSON.parse(record['prompt']) as unknown[];
			const postProcessingOutcome = JSON.parse(record['post_processing_outcome']) as {
				suggestedEdit: string;
				isInlineCompletion: boolean;
			};

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

export async function loadAndParseCsv(csvPath: string): Promise<{
	rows: ITelemetryRow[];
	errors: { rowIndex: number; error: string }[];
}> {
	const csvContents = await fs.readFile(csvPath, 'utf8');
	console.log(`Read ${csvContents.length} chars from ${csvPath}`);
	return parseTelemetryCsv(csvContents);
}
