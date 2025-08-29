/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AutoTokenizer } from '@huggingface/transformers';
import * as fs from 'fs';
import * as ort from 'onnxruntime-node';
import { Position, TextDocument } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { MockInlineCompletionClassifier } from './mockInlineCompletionClassifier';

export interface ClassificationResult {
	shouldProceed: boolean;
	confidence: number;
	processingTime: number;
}

/**
 * Classifier for determining whether inline completion should proceed
 */
export class InlineCompletionClassifier {
	private session: ort.InferenceSession | null = null;
	private tokenizer: any = null;
	private isInitialized = false;
	private modelPath: string;
	private mockClassifier: MockInlineCompletionClassifier | null = null;
	private useMockClassifier = false;

	constructor(
		private readonly logService: ILogService,
		modelPath?: string
	) {
		// Default model path - you should replace this with your actual .onnx model path
		this.modelPath = modelPath || './models/inline-completion-classifier.onnx';
		this.mockClassifier = new MockInlineCompletionClassifier(logService);
	}

	/**
	 * Initialize the classifier with ONNX model and tokenizer
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			// Check if the ONNX model file exists
			if (!fs.existsSync(this.modelPath)) {
				this.logService.warn(`[InlineCompletionClassifier] ONNX model not found at ${this.modelPath}, falling back to mock classifier`);
				this.useMockClassifier = true;
				await this.mockClassifier!.initialize();
				this.isInitialized = true;
				return;
			}

			this.logService.trace('[InlineCompletionClassifier] Initializing classifier...');

			// Load the ONNX model
			this.session = await ort.InferenceSession.create(this.modelPath);
			this.logService.trace('[InlineCompletionClassifier] ONNX model loaded successfully');

			// Load the tokenizer (you might need to specify the model name or path)
			// This is a placeholder - replace with your actual tokenizer
			this.tokenizer = await AutoTokenizer.from_pretrained('distilbert-base-uncased');
			this.logService.trace('[InlineCompletionClassifier] Tokenizer loaded successfully');

			this.isInitialized = true;
			this.logService.info('[InlineCompletionClassifier] Classifier initialized successfully');
		} catch (error) {
			this.logService.error('[InlineCompletionClassifier] Failed to initialize ONNX classifier, falling back to mock classifier:', error);
			this.useMockClassifier = true;
			await this.mockClassifier!.initialize();
			this.isInitialized = true;
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
				shouldProceed: true,
				confidence: 0.5,
				processingTime: Date.now() - startTime
			};
		}

		// Use mock classifier if ONNX model is not available
		if (this.useMockClassifier) {
			return await this.mockClassifier!.classify(document, position);
		}

		try {
			// Extract context from the document
			const context = this.extractContext(document, position);
			this.logService.trace(`[InlineCompletionClassifier] Extracted context: "${context}"`);

			// Tokenize the input
			const encoded = await this.tokenizer(context, {
				padding: true,
				truncation: true,
				max_length: 512,
				return_tensors: 'pt'
			});

			// Prepare input for ONNX model
			const inputIds = new ort.Tensor('int64', encoded.input_ids.data, encoded.input_ids.dims);
			const attentionMask = new ort.Tensor('int64', encoded.attention_mask.data, encoded.attention_mask.dims);

			// Run inference
			const results = await this.session!.run({
				input_ids: inputIds,
				attention_mask: attentionMask
			});

			// Process the results (assuming binary classification with sigmoid output)
			const logits = results.logits as ort.Tensor;
			const probability = this.sigmoid(logits.data[0] as number);

			const shouldProceed = probability > 0.5;
			const processingTime = Date.now() - startTime;

			this.logService.trace(`[InlineCompletionClassifier] Classification result: shouldProceed=${shouldProceed}, confidence=${probability.toFixed(3)}, time=${processingTime}ms`);

			return {
				shouldProceed,
				confidence: probability,
				processingTime
			};

		} catch (error) {
			this.logService.error('[InlineCompletionClassifier] Classification failed:', error);

			// Fallback to proceeding when classification fails
			return {
				shouldProceed: true,
				confidence: 0.5,
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
	 * Sigmoid activation function
	 */
	private sigmoid(x: number): number {
		return 1 / (1 + Math.exp(-x));
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		if (this.session) {
			this.session.release();
			this.session = null;
		}
		if (this.mockClassifier) {
			this.mockClassifier.dispose();
			this.mockClassifier = null;
		}
		this.tokenizer = null;
		this.isInitialized = false;
		this.logService.trace('[InlineCompletionClassifier] Classifier disposed');
	}
}