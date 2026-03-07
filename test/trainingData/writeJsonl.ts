/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { IGeneratedPrompt } from './generatePrompt';
import { IGeneratedResponse } from './generateResponse';
import { IProcessedRow } from './replayRecording';

export interface IMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

export interface ISampleMetadata {
	readonly rowIndex: number;
	readonly language: string;
	readonly strategy: string;
	readonly responseSource: 'oracle' | 'model';
	readonly oracleEditCount: number;
	readonly suggestionStatus: string;
	readonly filePath: string;
	readonly validationVerdict?: 'pass' | 'fail';
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
	readonly written: number;
	readonly skipped: number;
	readonly skipReasons: readonly ISkipReason[];
	readonly fileSize: number;
	readonly outputPath: string;
	readonly languageCounts: ReadonlyMap<string, number>;
}

export function assembleSample(
	index: number,
	prompt: IGeneratedPrompt,
	response: IGeneratedResponse,
	processedRow: IProcessedRow,
	strategy: string,
	validationVerdict?: 'pass' | 'fail',
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
		validationVerdict,
	};

	return { messages, metadata };
}

interface IStructuralValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

/**
 * Structural check: ensures messages are non-empty before writing.
 */
export function validateSample(sample: ITrainingSample): IStructuralValidationResult {
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

export function resolveOutputPath(csvPath: string, explicitPath: string | undefined): string {
	if (explicitPath) {
		return path.resolve(explicitPath);
	}
	const parsed = path.parse(csvPath);
	return path.join(parsed.dir, `${parsed.name}_sft.jsonl`);
}

/**
 * Write validated training samples to a JSONL file.
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

	validSamples.sort((a, b) => a.metadata.rowIndex - b.metadata.rowIndex);

	const lines = validSamples.map(sample => JSON.stringify({
		messages: sample.messages.map(m => ({ role: m.role, content: m.content })),
		metadata: sample.metadata,
	}));
	const content = lines.length > 0 ? lines.join('\n') + '\n' : '';

	const resolvedPath = path.resolve(outputPath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await fs.writeFile(resolvedPath, content, 'utf-8');

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
