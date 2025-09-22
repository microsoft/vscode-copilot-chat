/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { Position, Range, TextDocument, Uri } from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { join } from '../../../../util/vs/base/common/path';

const onnxOptions: ort.InferenceSession.SessionOptions = {
	executionProviders: [
		// "cpu",
		// "dml",
	],
	// intraOpNumThreads: 16,
	// interOpNumThreads: 16,
	graphOptimizationLevel: "all",
	// logSeverityLevel: 4,
};

const tokenizerOpts = {
	add_special_tokens: true,
	truncation: true,
	// max_length: 256,       // TODO: combined with padding returns a BigInt error
	return_tensors: 'ort',
	return_token_type_ids: true,
};

export interface ClassificationResult {
	confidence: number | null;
	processingTime: number;
}

export class InlineCompletionClassifier {
	static modelPath = "models/graph_code_bert_finetuned/model.onnx";
	static tokenizerPath = "models/graph_code_bert_finetuned/tokenizer.json";
	static tokenizerCfgPath = "models/graph_code_bert_finetuned/tokenizer_config.json";

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
			this._logService.info('[InlineCompletionClassifier] Initializing classifier...');

			const absoluteModelPath = Uri.file(join(__dirname, InlineCompletionClassifier.modelPath));
			const absoluteTokenizerPath = Uri.file(join(__dirname, InlineCompletionClassifier.tokenizerPath));
			const absoluteTokenizerCfgPath = Uri.file(join(__dirname, InlineCompletionClassifier.tokenizerCfgPath));

			const modelU8Array = await this._fileSystemService.readFile(absoluteModelPath, /*disableLimit=*/true);
			this.session = await ort.InferenceSession.create(modelU8Array, onnxOptions);
			this._logService.info('[InlineCompletionClassifier] ONNX model loaded successfully');

			const tokenizerJsonU8Array = await this._fileSystemService.readFile(absoluteTokenizerPath);
			const tokenizerJsonStr = new TextDecoder().decode(tokenizerJsonU8Array);
			const tokenizerJson = JSON.parse(tokenizerJsonStr);

			const tokenizerCfgU8Array = await this._fileSystemService.readFile(absoluteTokenizerCfgPath);
			const tokenizerCfgStr = new TextDecoder().decode(tokenizerCfgU8Array);
			const tokenizerConfig = JSON.parse(tokenizerCfgStr);

			this.tokenizer = new PreTrainedTokenizer(tokenizerJson, tokenizerConfig);
			this._logService.info('[InlineCompletionClassifier] Tokenizer loaded successfully');

			try {
				this._logService.info('[InlineCompletionClassifier] Performing warm-up run...');
				const dummyFeeds = await this.tokenizer!('warm-up', {
					truncation: true,
					return_tensors: 'pt',
					return_token_type_ids: true,
				});
				await this.session!.run(dummyFeeds);
				this._logService.info('[InlineCompletionClassifier] Warm-up run completed.');
			} catch (error) {
				this._logService.error('[InlineCompletionClassifier] Warm-up run failed', error);
				// Initialization can still be considered successful
			}

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
		const startTime = performance.now();
		const timer = () => performance.now() - startTime;

		if (!this.isInitialized) {
			this._logService.warn('[InlineCompletionClassifier] Classifier not initialized, proceeding by default');
			return {
				confidence: null,
				processingTime: timer(),
			};
		}

		try {
			const kContextLineRadius = 5;
			const begLine = Math.max(0, position.line - kContextLineRadius);
			const endLine = Math.min(document.lineCount, position.line + kContextLineRadius);
			const rangeStart = new Position(begLine, 0);
			const rangeEnd = new Position(endLine, document.lineAt(endLine).text.length);
			const contextBeforeCursor = document.getText(new Range(rangeStart, position));
			const contextAfterCursor = document.getText(new Range(position, rangeEnd));

			const startTimeTokenizer = timer();
			const feeds = await this.tokenizer!(contextBeforeCursor, contextAfterCursor, tokenizerOpts);
			const endTimeTokenizer = timer();

			const startTimeInference = timer();
			const results = await this.session!.run(feeds);
			const endTimeInference = timer();

			// The network was trained with [0="empty", 1="non-empty"]
			const logits = results.logits.data as Float32Array;
			const maxLogit = Math.max(...logits);
			const exps = logits.map(x => Math.exp(x - maxLogit));
			const sumExps = exps.reduce((a, b) => a + b, 0);
			const probs = exps.map(x => x / sumExps);
			const probability = probs[1];

			this._logService.info([
				`[InlineCompletionClassifier] result=${probability.toFixed(3)}`,
				`numTokens=${feeds.input_ids.dims}`,
				`tokenization=${endTimeTokenizer - startTimeTokenizer}ms`,
				`inference=${endTimeInference - startTimeInference}ms`,
			].join(", "));

			return {
				confidence: probability,
				processingTime: timer(),
			} as ClassificationResult;

		} catch (error) {
			this._logService.error('[InlineCompletionClassifier] Classification failed:', error);
			return {
				confidence: null,
				processingTime: timer(),
			} as ClassificationResult;
		}
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
		this._logService.info('[InlineCompletionClassifier] Classifier disposed');
	}
}