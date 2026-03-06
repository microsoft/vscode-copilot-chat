/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { IGeneratedPrompt } from './generatePrompt';
import { IGeneratedResponse } from './generateResponse';
import { IProcessedRow } from './replayRecording';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

export interface ISampleMetadata {
	/** Index of this row in the processed array */
	readonly rowIndex: number;
	/** Programming language of the active document */
	readonly language: string;
	/** Prompting strategy used (e.g. patchBased02, xtab275) */
	readonly strategy: string;
	/** Whether the assistant response came from oracle or model */
	readonly responseSource: 'oracle' | 'model';
	/** Number of oracle edits applied (0 for model source) */
	readonly oracleEditCount: number;
	/** Original suggestion status from telemetry (e.g. rejected, accepted) */
	readonly suggestionStatus: string;
	/** File path where the edit occurred (forward slashes) */
	readonly filePath: string;
}

export interface ITrainingSample {
	readonly messages: readonly IMessage[];
	readonly metadata: ISampleMetadata;
}

interface ISkipReason {
	readonly rowIndex: number;
	readonly reason: string;
}

export interface IJsonlWriteResult {
	/** Number of samples written to file */
	readonly written: number;
	/** Number of samples skipped due to validation failure */
	readonly skipped: number;
	/** Details for each skipped sample */
	readonly skipReasons: readonly ISkipReason[];
	/** File size in bytes */
	readonly fileSize: number;
	/** Output file path */
	readonly outputPath: string;
	/** Count of samples per language */
	readonly languageCounts: ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a training sample from prompt, response, and metadata.
 */
export function assembleSample(
	index: number,
	prompt: IGeneratedPrompt,
	response: IGeneratedResponse,
	processedRow: IProcessedRow,
	strategy: string,
): ITrainingSample {
	const messages: IMessage[] = [
		{ role: 'system', content: prompt.system },
		{ role: 'user', content: prompt.user },
		{ role: 'assistant', content: response.assistant },
	];

	const metadata: ISampleMetadata = {
		rowIndex: index,
		language: processedRow.row.activeDocumentLanguageId,
		strategy,
		responseSource: response.source,
		oracleEditCount: processedRow.nextUserEdit?.edit?.length ?? 0,
		suggestionStatus: processedRow.row.suggestionStatus,
		filePath: processedRow.activeFilePath.replace(/\\/g, '/'),
	};

	return { messages, metadata };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface IValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

/**
 * Validate that a training sample is suitable for writing to JSONL.
 * This is a basic structural check — NOT the full tree-sitter/heuristic
 * validation suite (which is Step 4b, deferred).
 */
export function validateSample(sample: ITrainingSample): IValidationResult {
	for (const msg of sample.messages) {
		if (msg.content === undefined || msg.content === null) {
			return { valid: false, reason: `${msg.role} message content is null/undefined` };
		}
		if (typeof msg.content !== 'string') {
			return { valid: false, reason: `${msg.role} message content is not a string` };
		}
	}

	const system = sample.messages.find(m => m.role === 'system');
	const user = sample.messages.find(m => m.role === 'user');
	const assistant = sample.messages.find(m => m.role === 'assistant');

	if (!system || !system.content.trim()) {
		return { valid: false, reason: 'Empty system message' };
	}
	if (!user || !user.content.trim()) {
		return { valid: false, reason: 'Empty user message' };
	}
	if (!assistant || !assistant.content.trim()) {
		return { valid: false, reason: 'Empty assistant message' };
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Resolve the output path for the JSONL file.
 * If `explicitPath` is provided, use it. Otherwise, derive from the CSV path.
 */
export function resolveOutputPath(csvPath: string, explicitPath: string | undefined): string {
	if (explicitPath) {
		return path.resolve(explicitPath);
	}
	const parsed = path.parse(csvPath);
	return path.join(parsed.dir, `${parsed.name}_sft.jsonl`);
}

/**
 * Write validated training samples to a JSONL file.
 *
 * Each line is a self-contained JSON object with `messages` and `metadata`.
 * Invalid samples are skipped and their reasons are collected.
 * Samples are sorted by rowIndex for deterministic output.
 */
export async function writeTrainingSamples(
	outputPath: string,
	samples: readonly ITrainingSample[],
): Promise<IJsonlWriteResult> {
	const skipReasons: ISkipReason[] = [];
	const validSamples: ITrainingSample[] = [];

	for (const sample of samples) {
		const result = validateSample(sample);
		if (result.valid) {
			validSamples.push(sample);
		} else {
			skipReasons.push({
				rowIndex: sample.metadata.rowIndex,
				reason: result.reason!,
			});
		}
	}

	// Sort by rowIndex for deterministic output
	validSamples.sort((a, b) => a.metadata.rowIndex - b.metadata.rowIndex);

	// Build JSONL content — one JSON object per line, LF line endings
	const lines = validSamples.map(sample => JSON.stringify({
		messages: sample.messages.map(m => ({ role: m.role, content: m.content })),
		metadata: sample.metadata,
	}));
	const content = lines.length > 0 ? lines.join('\n') + '\n' : '';

	// Write file
	const resolvedPath = path.resolve(outputPath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await fs.writeFile(resolvedPath, content, 'utf-8');

	// Compute stats
	const fileSize = Buffer.byteLength(content, 'utf-8');
	const languageCounts = new Map<string, number>();
	for (const sample of validSamples) {
		const lang = sample.metadata.language || 'unknown';
		languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
	}

	return {
		written: validSamples.length,
		skipped: skipReasons.length,
		skipReasons,
		fileSize,
		outputPath: resolvedPath,
		languageCounts,
	};
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Print a summary of the JSONL write operation.
 */
export function printJsonlDiagnostics(result: IJsonlWriteResult): void {
	console.log(`\n  Output: ${result.outputPath}`);
	console.log(`  Written: ${result.written} samples (${formatFileSize(result.fileSize)})`);

	if (result.skipped > 0) {
		console.log(`  Skipped: ${result.skipped} samples`);

		// Group skip reasons
		const reasonCounts = new Map<string, number>();
		for (const { reason } of result.skipReasons) {
			reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
		}
		for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
			console.log(`    - ${reason}: ${count}`);
		}
	}

	// Language distribution
	if (result.languageCounts.size > 0) {
		const sorted = [...result.languageCounts.entries()].sort((a, b) => b[1] - a[1]);
		const langSummary = sorted.slice(0, 10).map(([lang, count]) => `${lang} (${count})`).join(', ');
		const suffix = sorted.length > 10 ? `, +${sorted.length - 10} more` : '';
		console.log(`  Languages: ${langSummary}${suffix}`);
	}
}
