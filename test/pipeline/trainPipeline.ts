/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fork } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createExtensionUnitTestingServices } from '../../src/extension/test/node/services';
import { ConfigKey, IConfigurationService } from '../../src/platform/configuration/common/configurationService';
import { PromptingStrategy } from '../../src/platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { SimulationOptions } from '../base/simulationOptions';
import { assembleSample, ISample, resolveOutputPath, writeSamples } from './output';
import { loadAndParseInput } from './parseInput';
import { generatePromptFromRecording, IGeneratedPrompt } from './promptStep';
import { parseSuggestedEdit, processAllRows } from './replayRecording';
import { generateAllResponses, generateResponse, IResponseGenerationInput } from './responseStep';

/** Case-insensitive lookup of CLI strategy value against PromptingStrategy enum. */
export function resolvePromptingStrategy(input: string): PromptingStrategy {
	const lowerInput = input.toLowerCase();
	for (const value of Object.values(PromptingStrategy)) {
		if (value.toLowerCase() === lowerInput) {
			return value;
		}
	}
	throw new Error(`Unknown strategy: '${input}'. Supported: ${Object.values(PromptingStrategy).join(', ')}`);
}

function logErrors(errors: readonly { error: string }[], verbose: boolean): void {
	if (errors.length > 0 && verbose) {
		for (const err of errors) {
			console.log(`    ${err.error}`);
		}
	}
}

/**
 * Run N async tasks concurrently with a maximum degree of parallelism.
 * Spawns `concurrency` worker coroutines that pull items from a shared queue.
 */
async function runWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const idx = nextIndex++;
			await fn(items[idx], idx);
		}
	}
	const workers = Array.from(
		{ length: effectiveConcurrency },
		() => worker(),
	);
	await Promise.all(workers);
}

function formatElapsed(startTime: number): string {
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	return `${elapsed}s`;
}

export async function runInputPipeline(opts: SimulationOptions): Promise<void> {
	const inputPath = opts.trainInput!;
	const strategy = resolvePromptingStrategy(opts.trainStrategy ?? 'patchBased02');
	const verbose = !!opts.verbose;
	const concurrency = opts.parallelism;
	const rowOffset = opts.trainRowOffset;

	console.log(`\n=== Pipeline ===`);
	console.log(`  Input: ${inputPath}`);
	console.log(`  Strategy: ${strategy}, Concurrency: ${concurrency}\n`);

	// Step 1: Parse input
	const { rows, errors } = await loadAndParseInput(inputPath, verbose);
	console.log(`  [1/5] Input parsed: ${rows.length} rows, ${errors.length} errors`);
	logErrors(errors, verbose);

	// Step 2: Replay recordings
	const { processed, errors: replayErrors } = processAllRows(rows);
	console.log(`  [2/5] Recordings replayed: ${processed.length} ok, ${replayErrors.length} errors`);
	logErrors(replayErrors.map(e => ({
		error: `[sample ${e.rowIndex + rowOffset}, ${rows[e.rowIndex]?.activeDocumentLanguageId ?? '?'}] ${e.error}`,
	})), verbose);

	// Step 3: Generate prompts
	const serviceCollection = createExtensionUnitTestingServices();
	const testAccessor = serviceCollection.createTestingAccessor();

	try {
		const configService = testAccessor.get(IConfigurationService);

		//FIXME @ulugbekna: we should take this from `--config` not hard-code
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfiguration, {
			modelName: 'pipeline',
			promptingStrategy: strategy,
			includeTagsInCurrentFile: true,
			lintOptions: undefined,
		});

		// Disable interactive debounce for batch mode
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsDebounce, 0);
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsCacheDelay, 0);
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsExtraDebounceEndOfLine, 0);
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsExtraDebounceInlineSuggestion, 0);

		const prompts: { index: number; prompt: IGeneratedPrompt }[] = [];
		const promptErrors: { index: number; error: string }[] = [];
		let promptsCompleted = 0;
		const promptStartTime = Date.now();

		await runWithConcurrency(processed, concurrency, async (p, _i) => {
			const globalIdx = p.originalRowIndex + rowOffset;
			const result = await generatePromptFromRecording(testAccessor, p.recordingInfo);
			if ('error' in result) {
				promptErrors.push({ index: p.originalRowIndex, error: `[sample ${globalIdx}, ${p.row.activeDocumentLanguageId}, ${p.activeFilePath}] ${result.error}` });
			} else {
				prompts.push({ index: p.originalRowIndex, prompt: result });
			}
			promptsCompleted++;
			if (verbose && (promptsCompleted % 50 === 0 || promptsCompleted === processed.length)) {
				console.log(`    Progress: ${promptsCompleted}/${processed.length} (${formatElapsed(promptStartTime)})`);
			}
		});

		console.log(`  [3/5] Prompts generated: ${prompts.length} ok, ${promptErrors.length} errors (${formatElapsed(promptStartTime)})`);
		logErrors(promptErrors, verbose);

		// Step 4: Generate responses
		const processedByOriginalIndex = new Map(processed.map(p => [p.originalRowIndex, p]));
		const responseInputs: IResponseGenerationInput[] = [];

		for (const { index, prompt } of prompts) {
			const p = processedByOriginalIndex.get(index);
			if (!p) {
				continue;
			}
			responseInputs.push({
				index,
				oracleEdits: p.nextUserEdit?.edit,
				docContent: p.activeDocument.value.get().value,
				filePath: p.activeFilePath,
				userPrompt: prompt.user,
			});
		}

		const { responses, errors: responseErrors } = generateAllResponses(strategy, responseInputs);
		console.log(`  [4/5] Responses generated: ${responses.length} ok, ${responseErrors.length} errors`);
		logErrors(responseErrors.map(e => {
			const p = processedByOriginalIndex.get(e.index);
			return { error: `[sample ${e.index + rowOffset}, ${p?.row.activeDocumentLanguageId ?? '?'}] ${e.error}` };
		}), verbose);

		// Step 5: Write output
		const responseByIndex = new Map(responses.map(r => [r.index, r.response]));
		const outputPath = resolveOutputPath(inputPath, opts.trainOutput);
		const samples: ISample[] = [];

		for (const { index, prompt } of prompts) {
			const response = responseByIndex.get(index);
			if (!response) {
				continue;
			}
			const p = processedByOriginalIndex.get(index);
			if (!p) {
				continue;
			}
			const suggestedEdit = parseSuggestedEdit(p.row.postProcessingOutcome.suggestedEdit);
			const modelEdits = suggestedEdit ? [suggestedEdit] as const : undefined;
			const modelResult = generateResponse(strategy, modelEdits, p.activeDocument.value.get().value, p.activeFilePath, prompt.user);
			const formattedModelResponse = 'error' in modelResult ? '' : modelResult.assistant;
			samples.push(assembleSample(index + rowOffset, prompt, response, p, strategy, formattedModelResponse));
		}

		const writeResult = await writeSamples(outputPath, samples);
		console.log(`  [5/5] Output written: ${writeResult.written} samples → ${writeResult.outputPath}`);
		if (writeResult.skipped > 0) {
			console.log(`    Structural validation dropped ${writeResult.skipped} samples`);
			if (verbose) {
				const grouped = new Map<string, number>();
				for (const s of writeResult.skipReasons) {
					grouped.set(s.reason, (grouped.get(s.reason) ?? 0) + 1);
				}
				for (const [reason, count] of grouped) {
					console.log(`    ${reason} (×${count})`);
				}
			}
		}

		// Summary
		console.log(`\n  Pipeline: Input(${rows.length}) → Replay(${processed.length}) → Prompt(${prompts.length}) → Response(${responses.length}) → Output(${writeResult.written})`);
	} finally {
		for (const p of processed) {
			p.replayer.dispose();
		}
		testAccessor.dispose();
	}
}

/**
 * Run the pipeline in parallel by splitting input across N child processes.
 * Each child runs the single-process pipeline on its chunk independently.
 */
export async function runInputPipelineParallel(opts: SimulationOptions): Promise<void> {
	const inputPath = opts.trainInput!;
	const verbose = !!opts.verbose;

	const contents = await fs.promises.readFile(inputPath, 'utf8');
	const records = JSON.parse(contents) as unknown[];
	const numWorkers = Math.max(1, Math.min(os.cpus().length, opts.parallelism, Math.ceil(records.length / 25)));

	console.log(`\n=== Pipeline (parallel: ${numWorkers} workers) ===`);
	console.log(`  Input: ${inputPath} (${records.length} rows)\n`);

	if (records.length === 0) {
		console.log(`  No records to process.`);
		return;
	}

	const chunkSize = Math.ceil(records.length / numWorkers);
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nes-pipeline-'));

	try {
		const workerPromises: Promise<void>[] = [];
		const resultPaths: string[] = [];

		for (let w = 0; w < numWorkers; w++) {
			const start = w * chunkSize;
			const chunk = records.slice(start, start + chunkSize);
			if (chunk.length === 0) {
				continue;
			}

			const chunkPath = path.join(tmpDir, `chunk_${w}.json`);
			const resultPath = path.join(tmpDir, `result_${w}.json`);
			resultPaths.push(resultPath);

			await fs.promises.writeFile(chunkPath, JSON.stringify(chunk));

			const args = [
				'--train-input', chunkPath,
				'--train-strategy', opts.trainStrategy ?? 'patchBased02', // FIXME @ulugbekna: do not hard code this
				'--train-out', resultPath,
				'--train-row-offset', String(start),
				'--parallelism', '5',
				'--train-worker',
			];
			if (verbose) {
				args.push('--verbose');
			}

			const workerIdx = w;
			workerPromises.push(new Promise<void>((resolve, reject) => {
				const child = fork(process.argv[1], args, { stdio: 'pipe' });

				// Always drain child output to prevent pipe buffer deadlocks
				child.stdout?.on('data', verbose ? (data: Buffer) => {
					const lines = data.toString().split('\n').filter(l => l.trim());
					for (const line of lines) {
						console.log(`  [W${workerIdx}] ${line}`);
					}
				} : () => { });
				child.stderr?.on('data', verbose ? (data: Buffer) => {
					const lines = data.toString().split('\n').filter(l => l.trim());
					for (const line of lines) {
						console.error(`  [W${workerIdx}] ${line}`);
					}
				} : () => { });

				child.on('exit', (code) => {
					if (code === 0) {
						console.log(`  Worker ${workerIdx + 1}/${numWorkers} completed (${chunk.length} rows)`);
						resolve();
					} else {
						reject(new Error(`Worker ${workerIdx} exited with code ${code}`));
					}
				});
				child.on('error', reject);
			}));
		}

		const startTime = Date.now();
		await Promise.all(workerPromises);
		const elapsed = formatElapsed(startTime);
		console.log(`\n  All ${numWorkers} workers completed in ${elapsed}`);

		// Merge results
		const allSamples: ISample[] = [];
		for (const resultPath of resultPaths) {
			try {
				const content = await fs.promises.readFile(resultPath, 'utf8');
				const samples = JSON.parse(content) as ISample[];
				allSamples.push(...samples);
			} catch {
				console.error(`  Warning: could not read result file ${resultPath}`);
			}
		}

		const outputPath = resolveOutputPath(inputPath, opts.trainOutput);
		const writeResult = await writeSamples(outputPath, allSamples);
		console.log(`  Output: ${writeResult.written} samples → ${writeResult.outputPath} (${elapsed})`);
	} finally {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
}
