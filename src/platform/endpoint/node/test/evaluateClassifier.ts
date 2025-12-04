/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { ReasoningClassifier } from '../reasoningClassifier';

// Simple console logger
const consoleLogger: ILogService = {
	trace: (message: string) => console.log(`[TRACE] ${message}`),
	debug: (message: string) => console.log(`[DEBUG] ${message}`),
	info: (message: string) => console.log(`[INFO] ${message}`),
	warn: (message: string) => console.warn(`[WARN] ${message}`),
	error: (message: string, error?: unknown) => console.error(`[ERROR] ${message}`, error),
	getLevel: () => 0,
	flush: async () => { },
	dispose: () => { },
	_serviceBrand: undefined
} as unknown as ILogService;

// Simple fetcher service using native fetch
const createFetcherService = (): IFetcherService => ({
	fetch: async (url: string, options?: RequestInit) => {
		const response = await fetch(url, options);
		return {
			ok: response.ok,
			statusText: response.statusText,
			text: async () => response.text(),
			body: async () => {
				const buffer = await response.arrayBuffer();
				return new Uint8Array(buffer);
			}
		};
	},
	_serviceBrand: undefined
} as unknown as IFetcherService);

interface ValidationEntry {
	text?: string;       // v0 format
	request?: string;    // v1 format
	label?: number;      // v0 format: 0 = reasoning, 1 = non-reasoning
	llm_vote?: number;   // v1 format: 0 = reasoning, 1 = non-reasoning
}

// Get text from entry (supports both v0 and v1 formats)
function getEntryText(entry: ValidationEntry): string {
	return entry.text ?? entry.request ?? '';
}

// Get label from entry (supports both v0 and v1 formats)
function getEntryLabel(entry: ValidationEntry): number {
	return entry.label ?? entry.llm_vote ?? 0;
}

interface EvaluationMetrics {
	accuracy: number;
	precision: number;
	recall: number;
	f1Score: number;
	truePositives: number;
	trueNegatives: number;
	falsePositives: number;
	falseNegatives: number;
	totalSamples: number;
	confusionMatrix: {
		reasoningCorrect: number;
		reasoningIncorrect: number;
		nonReasoningCorrect: number;
		nonReasoningIncorrect: number;
	};
	performance: {
		totalInferenceTimeMs: number;
		averageInferenceTimeMs: number;
		minInferenceTimeMs: number;
		maxInferenceTimeMs: number;
		medianInferenceTimeMs: number;
		p95InferenceTimeMs: number;
		p99InferenceTimeMs: number;
		inferencesPerSecond: number;
	};
}

async function evaluateClassifier(
	validationJsonPath: string,
	limit?: number
): Promise<EvaluationMetrics> {
	console.log('='.repeat(80));
	console.log('Reasoning Classifier Evaluation (Remote API)');
	console.log('='.repeat(80));
	console.log(`Validation data: ${validationJsonPath}`);
	console.log('='.repeat(80));

	// Load validation data
	const validationData: ValidationEntry[] = fs
		.readFileSync(validationJsonPath, 'utf-8')
		.split('\n')
		.filter(line => line.trim())
		.map(line => JSON.parse(line));

	// Shuffle the data to avoid any ordering bias
	for (let i = validationData.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[validationData[i], validationData[j]] = [validationData[j], validationData[i]];
	}

	const totalEntries = validationData.length;
	const entriesToProcess = limit ? validationData.slice(0, limit) : validationData;

	console.log(`\nLoaded ${totalEntries} validation entries`);
	if (limit) {
		console.log(`Evaluating first ${entriesToProcess.length} entries`);
	}
	console.log();

	// Initialize classifier with remote API
	const fetcherService = createFetcherService();
	const classifier = new ReasoningClassifier(fetcherService, consoleLogger);

	console.log('Starting evaluation (using remote API)...\n');

	// Warm up the connection with a single request
	await classifier.classify('warm up query');
	console.log('Connection warmed up, starting evaluation...\n');

	// Metrics
	let truePositives = 0; // Predicted non-reasoning (1), actual non-reasoning (1)
	let trueNegatives = 0; // Predicted reasoning (0), actual reasoning (0)
	let falsePositives = 0; // Predicted non-reasoning (1), actual reasoning (0)
	let falseNegatives = 0; // Predicted reasoning (0), actual non-reasoning (1)

	// Performance metrics
	let totalInferenceTimeMs = 0;
	let minInferenceTimeMs = Infinity;
	let maxInferenceTimeMs = 0;
	const inferenceTimes: number[] = [];

	// Process each entry
	for (let i = 0; i < entriesToProcess.length; i++) {
		const entry = entriesToProcess[i];
		const actualLabel = getEntryLabel(entry);
		const text = getEntryText(entry);

		if (!text) {
			console.log(`Skipping entry ${i + 1}: No text or request field found`);
			continue;
		}

		try {
			// Measure inference time
			const startTime = performance.now();
			// Classify returns true for non-reasoning (1), false for reasoning (0)
			const prediction = await classifier.classify(text);
			const endTime = performance.now();
			const inferenceTimeMs = endTime - startTime;

			// Track inference time
			inferenceTimes.push(inferenceTimeMs);
			totalInferenceTimeMs += inferenceTimeMs;
			minInferenceTimeMs = Math.min(minInferenceTimeMs, inferenceTimeMs);
			maxInferenceTimeMs = Math.max(maxInferenceTimeMs, inferenceTimeMs);

			const predictedLabel = prediction ? 1 : 0;

			// Update confusion matrix
			if (predictedLabel === 1 && actualLabel === 1) {
				truePositives++;
			} else if (predictedLabel === 0 && actualLabel === 0) {
				trueNegatives++;
			} else if (predictedLabel === 1 && actualLabel === 0) {
				falsePositives++;
			} else if (predictedLabel === 0 && actualLabel === 1) {
				falseNegatives++;
			}

			// Progress indicator
			if ((i + 1) % 100 === 0 || i === entriesToProcess.length - 1) {
				const progress = ((i + 1) / entriesToProcess.length * 100).toFixed(1);
				const correct = truePositives + trueNegatives;
				const currentAccuracy = ((correct / (i + 1)) * 100).toFixed(1);
				console.log(`Progress: ${i + 1}/${entriesToProcess.length} (${progress}%) | Accuracy: ${currentAccuracy}%`);
			}
		} catch (error) {
			console.error(`Error processing entry ${i + 1}:`, error);
		}
	}

	classifier.dispose();

	// Calculate metrics
	const totalSamples = entriesToProcess.length;
	const accuracy = (truePositives + trueNegatives) / totalSamples;
	const precision = truePositives / (truePositives + falsePositives) || 0;
	const recall = truePositives / (truePositives + falseNegatives) || 0;
	const f1Score = 2 * (precision * recall) / (precision + recall) || 0;

	// Calculate performance metrics
	const averageInferenceTimeMs = totalInferenceTimeMs / totalSamples;
	const inferencesPerSecond = 1000 / averageInferenceTimeMs;

	// Calculate percentiles
	const sortedTimes = inferenceTimes.slice().sort((a, b) => a - b);
	const getPercentile = (p: number) => {
		const index = Math.ceil((p / 100) * sortedTimes.length) - 1;
		return sortedTimes[Math.max(0, index)];
	};
	const medianInferenceTimeMs = getPercentile(50);
	const p95InferenceTimeMs = getPercentile(95);
	const p99InferenceTimeMs = getPercentile(99);

	const metrics: EvaluationMetrics = {
		accuracy,
		precision,
		recall,
		f1Score,
		truePositives,
		trueNegatives,
		falsePositives,
		falseNegatives,
		totalSamples,
		confusionMatrix: {
			reasoningCorrect: trueNegatives,
			reasoningIncorrect: falsePositives,
			nonReasoningCorrect: truePositives,
			nonReasoningIncorrect: falseNegatives
		},
		performance: {
			totalInferenceTimeMs,
			averageInferenceTimeMs,
			minInferenceTimeMs: minInferenceTimeMs === Infinity ? 0 : minInferenceTimeMs,
			maxInferenceTimeMs,
			medianInferenceTimeMs,
			p95InferenceTimeMs,
			p99InferenceTimeMs,
			inferencesPerSecond
		}
	};

	return metrics;
}

function printMetrics(metrics: EvaluationMetrics): void {
	console.log('\n' + '='.repeat(80));
	console.log('EVALUATION RESULTS');
	console.log('='.repeat(80));
	console.log(`\nTotal Samples: ${metrics.totalSamples}`);
	console.log('\nOverall Metrics:');
	console.log(`  Accuracy:  ${(metrics.accuracy * 100).toFixed(2)}%`);
	console.log(`  Precision: ${(metrics.precision * 100).toFixed(2)}%`);
	console.log(`  Recall:    ${(metrics.recall * 100).toFixed(2)}%`);
	console.log(`  F1 Score:  ${(metrics.f1Score * 100).toFixed(2)}%`);

	console.log('\nConfusion Matrix:');
	console.log('                          Actual');
	console.log('                 Reasoning  Non-Reasoning');
	console.log(`  Predicted`);
	console.log(`    Reasoning      ${metrics.trueNegatives.toString().padStart(4)}        ${metrics.falseNegatives.toString().padStart(4)}`);
	console.log(`    Non-Reasoning  ${metrics.falsePositives.toString().padStart(4)}        ${metrics.truePositives.toString().padStart(4)}`);

	console.log('\nDetailed Breakdown:');
	console.log(`  True Positives (Non-Reasoning correctly identified):  ${metrics.truePositives}`);
	console.log(`  True Negatives (Reasoning correctly identified):       ${metrics.trueNegatives}`);
	console.log(`  False Positives (Reasoning misclassified as Non):      ${metrics.falsePositives}`);
	console.log(`  False Negatives (Non-Reasoning misclassified as R):    ${metrics.falseNegatives}`);

	console.log('\nPerformance Metrics:');
	console.log(`  Total Inference Time:    ${metrics.performance.totalInferenceTimeMs.toFixed(2)} ms`);
	console.log(`  Average Inference Time:  ${metrics.performance.averageInferenceTimeMs.toFixed(2)} ms`);
	console.log(`  Median Inference Time:   ${metrics.performance.medianInferenceTimeMs.toFixed(2)} ms`);
	console.log(`  Min Inference Time:      ${metrics.performance.minInferenceTimeMs.toFixed(2)} ms`);
	console.log(`  Max Inference Time:      ${metrics.performance.maxInferenceTimeMs.toFixed(2)} ms`);
	console.log(`  95th Percentile:         ${metrics.performance.p95InferenceTimeMs.toFixed(2)} ms`);
	console.log(`  99th Percentile:         ${metrics.performance.p99InferenceTimeMs.toFixed(2)} ms`);
	console.log(`  Inferences Per Second:   ${metrics.performance.inferencesPerSecond.toFixed(2)}`);
	console.log('='.repeat(80));
}

// Main execution
async function main() {
	const args = process.argv.slice(2);
	const dataFile = args[0] || 'eval_data_100.json';
	const limit = args[1] ? parseInt(args[1], 10) : undefined;

	const validationJsonPath = path.join(__dirname, dataFile);

	try {
		const metrics = await evaluateClassifier(validationJsonPath, limit);
		printMetrics(metrics);

		// Save metrics to file
		const metricsPath = path.join(__dirname, 'evaluation-metrics.json');
		fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
		console.log(`\nMetrics saved to: ${metricsPath}`);
	} catch (error) {
		console.error('Evaluation failed:', error);
		process.exit(1);
	}
}

main();
