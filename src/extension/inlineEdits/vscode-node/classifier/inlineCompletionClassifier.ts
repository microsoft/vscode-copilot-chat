/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { Position, TextDocument, Uri } from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { join } from '../../../../util/vs/base/common/path';

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
		@ILogService private readonly _logService: ILogService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
	) {
	}

	/**
	 * The initialization happens asynchronously to avoid blocking the constructor.
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			this._logService.trace('[InlineCompletionClassifier] Initializing classifier...');
			this._logService.info(`[InlineCompletionClassifier] dirname is... ${__dirname}`);

			const absoluteModelPath = Uri.file(join(__dirname, InlineCompletionClassifier.modelPath));
			const absoluteTokenizerPath = Uri.file(join(__dirname, InlineCompletionClassifier.tokenizerPath));
			const absoluteTokenizerCfgPath = Uri.file(join(__dirname, InlineCompletionClassifier.tokenizerCfgPath));

			const absoluteModelU8Array = await this._fileSystemService.readFile(absoluteModelPath, /*disableLimit=*/true);
			this.session = await ort.InferenceSession.create(absoluteModelU8Array, onnxOptions);
			this._logService.info('[InlineCompletionClassifier] ONNX model loaded successfully');

			const tokenizerJsonU8Array = await this._fileSystemService.readFile(absoluteTokenizerPath);
			const tokenizerJsonStr = new TextDecoder().decode(tokenizerJsonU8Array);
			const tokenizerJson = JSON.parse(tokenizerJsonStr);

			const tokenizerCfgU8Array = await this._fileSystemService.readFile(absoluteTokenizerCfgPath);
			const tokenizerCfgStr = new TextDecoder().decode(tokenizerCfgU8Array);
			const tokenizerConfig = JSON.parse(tokenizerCfgStr);

			this.tokenizer = new PreTrainedTokenizer(tokenizerJson, tokenizerConfig);
			this._logService.info('[InlineCompletionClassifier] Tokenizer loaded successfully');

			this.isInitialized = true;
			this._logService.info('[InlineCompletionClassifier] Classifier initialized successfully');
		} catch (error) {
			this._logService.error('[InlineCompletionClassifier] Failed to initialize ONNX classifier', error);
			this.isInitialized = false;
		}
	}

	/**
	 * Classify whether inline completion should proceed based on document content
	 */
	async classify(document: TextDocument, position: Position): Promise<ClassificationResult> {
		const startTime = Date.now();

		if (!this.isInitialized) {
			this._logService.warn('[InlineCompletionClassifier] Classifier not initialized, proceeding by default');
			return {
				confidence: null,
				processingTime: Date.now() - startTime
			};
		}

		try {
			// Extract context from the document
			const context = this.extractContext(document, position);
			this._logService.trace(`[InlineCompletionClassifier] Extracted context: "${context}"`);

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
			this._logService.trace(`[InlineCompletionClassifier] Classification result: confidence=${probability.toFixed(3)}, time=${processingTime}ms`);
			return {
				confidence: probability,
				processingTime: Date.now() - startTime
			};

		} catch (error) {
			this._logService.error('[InlineCompletionClassifier] Classification failed:', error);
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
		this._logService.trace(`[InlineCompletionClassifier] Current line: "${currentLine}"`);

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
		this._logService.trace('[InlineCompletionClassifier] Classifier disposed');
	}
}