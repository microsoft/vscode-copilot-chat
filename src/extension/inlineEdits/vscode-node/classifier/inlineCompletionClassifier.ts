/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { Position, TextDocument } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
// TODO(cecagnia): this seems forbidden. Need to find a way to do it in both node and web.
const path = require('path');
const fs = require('fs');

export interface ClassificationResult {
	confidence: number | null;
	processingTime: number;
}

const onnxOptions = {
	executionProviders: [
		{
			name: 'webgpu',
		}
	],
	logLevel: 'verbose',
};

/**
 * Classifier for determining whether inline completion should proceed
 */
export class InlineCompletionClassifier {
	static modelPath = "models/google_mobile_bert/model.onnx";
	static tokenizerPath = "models/google_mobile_bert/tokenizer.json";
	static tokenizerCfgPath = "models/google_mobile_bert/tokenizer_config.json";

	private isInitialized = false;
	private session: ort.InferenceSession | null = null;
	private tokenizer: PreTrainedTokenizer | null = null;

	constructor(
		private readonly logService: ILogService,
	) {
		this.logService = logService;
	}

	/**
	 * The initialization happens asynchronously to avoid blocking the constructor.
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			this.logService.trace('[InlineCompletionClassifier] Initializing classifier...');
			this.logService.info(`[InlineCompletionClassifier] dirname is... ${__dirname}`);
			const absoluteModelPath = path.join(__dirname, InlineCompletionClassifier.modelPath);

			this.session = await ort.InferenceSession.create(absoluteModelPath, onnxOptions);
			this.logService.info('[InlineCompletionClassifier] ONNX model loaded successfully');

			const absoluteTokenizerPath = path.join(__dirname, InlineCompletionClassifier.tokenizerPath);
			const absoluteTokenizerCfgPath = path.join(__dirname, InlineCompletionClassifier.tokenizerCfgPath);

			// Load and parse the tokenizer files to json
			const tok_json = JSON.parse(fs.readFileSync(absoluteTokenizerPath, 'utf-8'));
			const tok_cfg = JSON.parse(fs.readFileSync(absoluteTokenizerCfgPath, 'utf-8'));

			this.tokenizer = new PreTrainedTokenizer(tok_json, tok_cfg);
			this.logService.info('[InlineCompletionClassifier] Tokenizer loaded successfully');

			this.isInitialized = true;
			this.logService.info('[InlineCompletionClassifier] Classifier initialized successfully');
		} catch (error) {
			this.logService.error('[InlineCompletionClassifier] Failed to initialize ONNX classifier', error);
			this.isInitialized = false;
		}
	}

	/**
	 * Classify whether inline completion should proceed based on document content
	 */
	async classify(document: TextDocument, position: Position): Promise<ClassificationResult> {
		const startTime = Date.now();

		if (!this.isInitialized) {
			this.logService.warn('[InlineCompletionClassifier] Classifier not initialized, proceeding by default');
			return {
				confidence: null,
				processingTime: Date.now() - startTime
			};
		}

		try {
			// Extract context from the document
			const context = this.extractContext(document, position);
			this.logService.trace(`[InlineCompletionClassifier] Extracted context: "${context}"`);

			// Tokenize the input
			const tokenizerOpts = {
				add_special_tokens: false,
				padding: true,
				return_token_type_ids: true,
			};
			const feeds = await this.tokenizer!(context, tokenizerOpts);

			// Run inference
			const results = await this.session!.run(feeds);

			// Process the results (assuming binary classification with sigmoid output)
			const logits = results.logits.data as Float32Array;
			const maxLogit = Math.max(...logits);
			const exps = logits.map(x => Math.exp(x - maxLogit));
			const sumExps = exps.reduce((a, b) => a + b, 0);
			const probs = exps.map(x => x / sumExps);
			console.log("Probabilities:", probs);

			const probability = probs[1];
			const processingTime = Date.now() - startTime;
			this.logService.trace(`[InlineCompletionClassifier] Classification result: confidence=${probability.toFixed(3)}, time=${processingTime}ms`);
			return {
				confidence: probability,
				processingTime: Date.now() - startTime
			};

		} catch (error) {
			this.logService.error('[InlineCompletionClassifier] Classification failed:', error);
			return {
				confidence: null,
				processingTime: Date.now() - startTime
			};
		}
	}

	/**
	 * Extract relevant context from the document for classification
	 */
	private extractContext(document: TextDocument, position: Position): string {
		// Get the current line
		const currentLine = document.lineAt(position.line).text;

		// Get some context before and after
		const contextLines: string[] = [];
		const contextRadius = 2;

		for (let i = Math.max(0, position.line - contextRadius); i <= Math.min(document.lineCount - 1, position.line + contextRadius); i++) {
			contextLines.push(document.lineAt(i).text);
		}

		// Include current line context for better classification
		const context = contextLines.join('\n');

		// Log current line for debugging
		this.logService.trace(`[InlineCompletionClassifier] Current line: "${currentLine}"`);

		return context;
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		if (this.session) {
			this.session.release();
			this.session = null;
		}
		this.tokenizer = null;
		this.isInitialized = false;
		this.logService.trace('[InlineCompletionClassifier] Classifier disposed');
	}
}