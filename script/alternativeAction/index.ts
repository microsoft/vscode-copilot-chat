/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import csvParse from 'csv-parse';
import * as fs from 'fs/promises';
import minimist from 'minimist';
import { IAlternativeAction } from '../../src/extension/inlineEdits/node/nextEditProviderTelemetry';
import { Edits } from '../../src/platform/inlineEdits/common/dataTypes/edit';
import { LogEntry } from '../../src/platform/workspaceRecorder/common/workspaceLog';
import { StringEdit, StringReplacement } from '../../src/util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../src/util/vs/editor/common/core/ranges/offsetRange';
import { ISerializedEdit } from '../logRecordingTypes';
import { NextUserEdit, Recording, Scoring } from './types';
import { binarySearch, log } from './util';

function createScoringForAlternativeAction(altAction: IAlternativeAction): Scoring.t | undefined {
	if (!altAction.recording) {
		return undefined;
	}

	const recording = altAction.recording.entries;
	if (!recording || recording.length === 0) {
		return undefined;
	}

	const requestTime = altAction.recording.requestTime;

	const recordingIdxOfRequestTime = binarySearch(recording, (entry: LogEntry) => {
		if (entry.kind === 'meta') {
			return -1;
		} else {
			return entry.time - requestTime;
		}
	});

	if (recordingIdxOfRequestTime === -1) {
		log('Request time is before any recording entries');
		return undefined;
	}

	const recordingPriorToRequest = recording.slice(0, recordingIdxOfRequestTime + 1);
	const recordingAfterRequest = recording.slice(recordingIdxOfRequestTime + 1);

	const nextUserEdit = getNextUserEdit(recordingPriorToRequest, recordingAfterRequest);

	const reconstructedRecording: Recording.t = {
		log: recordingPriorToRequest,
		nextUserEdit,
	};

	const scoring = Scoring.create(reconstructedRecording);

	return scoring;
}

function documentIndexMapping(recording: LogEntry[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const entry of recording) {
		if (entry.kind === 'documentEncountered') {
			map.set(entry.id, entry.relativePath);
		}
	}
	return map;
}

function getNextUserEdit(recordingBeforeRequest: LogEntry[], recordingAfterRequest: LogEntry[]): NextUserEdit.t {
	let fileIdx: number | undefined;
	for (let i = recordingBeforeRequest.length - 1; i >= 0; i--) {
		const entry = recordingBeforeRequest[i];
		if ('id' in entry) {
			fileIdx = entry.id;
			break;
		}
	}

	if (fileIdx === undefined) {
		throw new Error('No file idx found in recording after request');
	}

	const N_EDITS_LIMIT = 10;

	const serializedEdits: ISerializedEdit[] = [];
	for (const entry of recordingAfterRequest) {
		if (entry.kind === 'changed' && 'id' in entry && entry.id === fileIdx) {
			serializedEdits.push(entry.edit);
		}
		if (serializedEdits.length > N_EDITS_LIMIT) {
			break;
		}
	}

	const edits = new Edits(
		StringEdit,
		serializedEdits.map(se =>
			new StringEdit(se.map(r =>
				new StringReplacement(new OffsetRange(r[0], r[1]), r[2]))
			)
		)
	);
	const fileIdxToPath = documentIndexMapping(recordingBeforeRequest);

	return {
		edit: edits.compose().replacements.map(r => [r.replaceRange.start, r.replaceRange.endExclusive, r.newText] as const),
		relativePath: fileIdxToPath.get(fileIdx) || '',
		originalOpIdx: recordingBeforeRequest.length - 1
	};
}

async function extractFromCsv(csvContents: string): Promise<(Scoring.t | undefined)[]> {
	const options = {
		columns: true,          // Use first row as column headers
		delimiter: ',',         // Comma delimiter
		quote: '"',             // Double quotes
		escape: '"',            // Standard CSV escape character
		skip_empty_lines: true, // Skip any empty rows
		trim: true,             // Remove whitespace around fields
		relax_quotes: true,     // Handle quotes within fields more flexibly
		bom: true,              // Handle UTF-8 BOM
		cast: false             // Keep all values as strings initially
	};

	const objects: Object[] = await new Promise((resolve, reject) => {
		csvParse.parse(csvContents, options, (err, result) => {
			if (err) {
				reject(err);
			} else {
				resolve(result);
			}
		});
	});

	const scoredEdits = objects.map((obj: any) => {
		if (!('Rec' in obj)) {
			return undefined;
		}
		const altAction: IAlternativeAction = JSON.parse(obj['Rec']);
		if (!altAction || !altAction.recording) {
			return undefined;
		}
		return createScoringForAlternativeAction(altAction);
	});

	return scoredEdits;
}

function writeFiles(basename: string, scoring: Scoring.t) {
	return [
		fs.writeFile(`${basename}.scoredEdits.w.json`, JSON.stringify(scoring, null, 2)),
		fs.writeFile(`${basename}.recording.w.json`, JSON.stringify(scoring.scoringContext.recording, null, 2)),
	];
}

async function handleCsv(inputFilePath: string) {
	log('Handling CSV file:', inputFilePath);
	const csvContents = await fs.readFile(inputFilePath, 'utf8');
	log('CSV contents read, length:', csvContents.length);
	const extracted = await extractFromCsv(csvContents);
	log('Extraction complete, number of scored edits:', extracted.filter(e => e).length);
	try {
		await Promise.all(extracted.flatMap((obj: Scoring.t | undefined, idx: number) => {
			if (!obj) {
				return [];
			}
			return writeFiles(idx.toString(), obj);
		}));
		log('All files written successfully');
	} catch (e) {
		log('Error writing files:', e);
	}
}

async function handleAlternativeActionJson(inputFilePath: string) {
	log('Handling alternative action JSON file:', inputFilePath);
	const fileContents = await fs.readFile(inputFilePath, 'utf8');
	log('File contents read, length:', fileContents.length);
	const altAction: IAlternativeAction = JSON.parse(fileContents);
	if (!altAction) {
		console.error('Failed to parse alternative action JSON file');
		return;
	}
	const scoring = createScoringForAlternativeAction(altAction);
	if (!scoring) {
		console.error('Failed to create scoring from alternative action');
		return;
	}
	const outputFilePath = inputFilePath.replace(/\.json$/, '.scoredEdits.json');
	await writeFiles(outputFilePath.replace(/\.scoredEdits\.json$/, ''), scoring);
	log('Scoring written to:', outputFilePath);
}


async function main() {
	const argv = minimist(process.argv.slice(2), {
		alias: {
			p: 'path',
			s: 'single',
			c: 'csv'
		},
		boolean: ['single', 'csv'],
		string: ['path']
	});

	if (!argv.path) {
		console.error('Please provide a path to an alternative action JSON file using --path or -p');
		process.exit(1);
	}

	const inputFilePath = argv.path;

	if (argv.csv) {
		await handleCsv(inputFilePath);
		return;
	}

	await handleAlternativeActionJson(inputFilePath);
	return;
}

main();
