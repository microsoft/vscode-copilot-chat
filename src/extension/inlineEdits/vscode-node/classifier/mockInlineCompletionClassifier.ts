/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position, TextDocument } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { ClassificationResult } from './inlineCompletionClassifier';

/**
 * Mock classifier for testing purposes
 * This provides a simple rule-based classification until you have your actual ONNX model
 */
export class MockInlineCompletionClassifier {
	constructor(
		private readonly logService: ILogService
	) { }

	async initialize(): Promise<void> {
		this.logService.trace('[MockInlineCompletionClassifier] Mock classifier initialized');
	}

	async classify(document: TextDocument, position: Position): Promise<ClassificationResult> {
		const startTime = Date.now();

		try {
			const currentLine = document.lineAt(position.line).text;
			const trimmedLine = currentLine.trim();

			// Simple rules for demonstration - you can modify these
			let shouldProceed = true;
			let confidence = 0.8;

			// Don't proceed if line is empty
			if (trimmedLine.length === 0) {
				shouldProceed = false;
				confidence = 0.9;
			}
			// Don't proceed if line is a comment
			else if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*') || trimmedLine.startsWith('#')) {
				shouldProceed = false;
				confidence = 0.85;
			}
			// Don't proceed if line contains certain keywords that typically don't need completion
			else if (this.containsSkipKeywords(trimmedLine)) {
				shouldProceed = false;
				confidence = 0.75;
			}
			// Lower confidence for very short lines
			else if (trimmedLine.length < 3) {
				confidence = 0.4;
			}

			const processingTime = Date.now() - startTime;

			this.logService.trace(`[MockInlineCompletionClassifier] Line: "${trimmedLine}" -> shouldProceed=${shouldProceed}, confidence=${confidence.toFixed(3)}, time=${processingTime}ms`);

			return {
				shouldProceed,
				confidence,
				processingTime
			};

		} catch (error) {
			this.logService.error('[MockInlineCompletionClassifier] Classification failed:', error);

			return {
				shouldProceed: true,
				confidence: 0.5,
				processingTime: Date.now() - startTime
			};
		}
	}

	private containsSkipKeywords(line: string): boolean {
		const skipKeywords = [
			'import',
			'export',
			'package',
			'using',
			'namespace',
			'#include',
			'#define'
		];

		const lowerLine = line.toLowerCase();
		return skipKeywords.some(keyword => lowerLine.includes(keyword));
	}

	dispose(): void {
		this.logService.trace('[MockInlineCompletionClassifier] Mock classifier disposed');
	}
}