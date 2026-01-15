/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AutoTokenizer } from '@xenova/transformers';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as ort from 'onnxruntime-web';
import * as path from 'path';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';

// ModernBERT reasoning classifier configuration

export const REASONING_CLASSIFIER_ZIP_FILENAME = 'model_router_v1.zip';
export const REASONING_CLASSIFIER_MODEL_FILENAME = 'model_int8.onnx';
const REASONING_CLASSIFIER_ASSETS_URL = 'https://your-model-host.com/model_router_v1.zip';
const REASONING_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.5;

/**
 * ModernBERT-based binary classifier for reasoning vs non-reasoning queries
 * Output: 0 = reasoning required, 1 = non-reasoning (simple query)
 */
export class ReasoningClassifier extends Disposable {
	private _session: ort.InferenceSession | undefined;
	private _tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | undefined;
	private _initPromise: Promise<void> | undefined;

	constructor(
		private readonly _modelCacheDir: string,
		private readonly _extensionPath: string | undefined,
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService
	) {
		super();
	}

	private async _downloadAndExtractAssets(): Promise<void> {
		const zipPath = path.join(this._modelCacheDir, REASONING_CLASSIFIER_ZIP_FILENAME);
		const modelPath = path.join(this._modelCacheDir, REASONING_CLASSIFIER_MODEL_FILENAME);

		// Check if assets already exist
		if (fs.existsSync(modelPath)) {
			this._logService.trace('Model assets already exist, skipping download');
			return;
		}

		// Ensure cache directory exists
		if (!fs.existsSync(this._modelCacheDir)) {
			fs.mkdirSync(this._modelCacheDir, { recursive: true });
		}

		// First, try to extract from bundled zip in extension directory
		if (this._extensionPath) {
			const bundledZipPath = path.join(this._extensionPath, 'dist', REASONING_CLASSIFIER_ZIP_FILENAME);
			if (fs.existsSync(bundledZipPath)) {
				this._logService.trace(`Extracting model assets from bundled zip: ${bundledZipPath}`);
				await this._extractZip(bundledZipPath, this._modelCacheDir);
				this._logService.trace('Model assets extracted from bundled zip successfully');
				return;
			}
		}

		// Fall back to downloading from remote URL
		this._logService.trace(`Downloading model assets from ${REASONING_CLASSIFIER_ASSETS_URL}`);
		const response = await this._fetcherService.fetch(REASONING_CLASSIFIER_ASSETS_URL, {});
		if (!response.ok) {
			throw new Error(`Failed to download model assets: ${response.statusText}`);
		}

		const body = await response.body();
		if (!body) {
			throw new Error('Empty response body from model assets download');
		}

		// Save zip file
		const buffer = body as Uint8Array;
		fs.writeFileSync(zipPath, buffer);
		this._logService.trace('Model assets downloaded, extracting...');

		// Extract zip file using Node.js zlib and manual ZIP parsing
		await this._extractZip(zipPath, this._modelCacheDir);

		// Clean up zip file
		fs.unlinkSync(zipPath);
		this._logService.trace('Model assets extracted successfully');
	}

	private async _extractZip(zipPath: string, targetDir: string): Promise<void> {
		// Extract zip file using adm-zip
		const zip = new AdmZip(zipPath);
		zip.extractAllTo(targetDir, true);
	}

	private async _initialize(): Promise<void> {
		if (this._session) {
			return;
		}

		try {
			// Download and extract model assets
			await this._downloadAndExtractAssets();

			// Define paths to extracted files
			const modelPath = path.join(this._modelCacheDir, REASONING_CLASSIFIER_MODEL_FILENAME);

			// Load tokenizer using @xenova/transformers
			const modelId = 'answerdotai/ModernBERT-base';

			this._tokenizer = await AutoTokenizer.from_pretrained(modelId);


			// Create ONNX inference session
			this._session = await ort.InferenceSession.create(modelPath, {
				executionProviders: ['wasm'],
				graphOptimizationLevel: 'all'
			});

			this._logService.info('Reasoning classifier initialized successfully');
		} catch (error) {
			this._logService.error('Failed to initialize reasoning classifier', error);
			throw error;
		}
	}

	private async _tokenize(text: string): Promise<{ input_ids: number[]; attention_mask: number[] }> {
		if (!this._tokenizer) {
			throw new Error('Tokenizer not initialized');
		}

		// Tokenize using @xenova/transformers AutoTokenizer
		// No padding needed since ONNX model uses dynamic shapes
		const encoded = await this._tokenizer(text, {
			max_length: 4096,
			truncation: true,
			return_tensors: false
		});

		// Convert to number arrays and validate
		const input_ids = Array.from(encoded.input_ids.data || encoded.input_ids).map(id => {
			const num = Number(id);
			if (isNaN(num) || !Number.isInteger(num)) {
				throw new Error(`Invalid token ID: ${id}`);
			}
			return num;
		});

		const attention_mask = Array.from(encoded.attention_mask.data || encoded.attention_mask).map(mask => {
			const num = Number(mask);
			if (isNaN(num) || !Number.isInteger(num)) {
				throw new Error(`Invalid attention mask value: ${mask}`);
			}
			return num;
		});

		return { input_ids, attention_mask };
	}

	/**
	 * Classify a query as reasoning (0) or non-reasoning (1)
	 * @param query The user's query text
	 * @returns true if non-reasoning (simple query), false if reasoning required
	 */
	async classify(query: string): Promise<boolean> {
		if (!this._initPromise) {
			this._initPromise = this._initialize();
		}
		await this._initPromise;

		if (!this._session) {
			throw new Error('Reasoning classifier not initialized');
		}

		try {
			// Tokenize input
			const { input_ids, attention_mask } = await this._tokenize(query);

			// Create tensors
			const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(input_ids.map(id => BigInt(id))), [1, input_ids.length]);
			const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attention_mask.map(mask => BigInt(mask))), [1, attention_mask.length]);

			// Run inference
			const feeds = {
				input_ids: inputIdsTensor,
				attention_mask: attentionMaskTensor
			};

			const results = await this._session.run(feeds);
			const output = results[Object.keys(results)[0]]; // Get first output

			// Get prediction (0 = reasoning, 1 = non-reasoning)
			const logits = output.data as Float32Array;

			// Apply softmax to get probabilities
			const expLogits = logits.map(l => Math.exp(l));
			const sumExp = expLogits.reduce((a, b) => a + b, 0);
			const probabilities = expLogits.map(e => e / sumExp);

			// Only predict non-reasoning if confidence is > threshold
			const nonReasoningConfidence = probabilities[1];
			const prediction = nonReasoningConfidence > REASONING_CLASSIFIER_CONFIDENCE_THRESHOLD ? 1 : 0;

			this._logService.trace(`Reasoning classifier prediction: ${prediction} (${prediction === 1 ? 'non-reasoning' : 'reasoning'}, confidence for non-reasoning: ${(nonReasoningConfidence * 100).toFixed(1)}%)`);
			return prediction === 1; // true if non-reasoning
		} catch (error) {
			this._logService.error('Reasoning classification failed', error);
			throw error;
		}
	}

	override dispose(): void {
		// onnxruntime-web sessions don't need explicit disposal
		this._session = undefined;
		this._tokenizer = undefined;
		super.dispose();
	}
}

