/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, InlineCompletionContext, InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionList, Position, Range, TextDocument } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Qwen3 Completion Provider for inline code completions
 */
export class Qwen3CompletionProvider extends Disposable implements InlineCompletionItemProvider {

	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info(`[Qwen3CompletionProvider] Initialized with baseUrl: ${baseUrl}`);
	}

	async provideInlineCompletionItems(
		document: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<InlineCompletionList | InlineCompletionItem[] | null> {
		try {
			return await this._provideInlineCompletionItems(document, position, context, token);
		} catch (error) {
			// Ignore AbortError - this is expected when VS Code cancels the request
			// (e.g., user continues typing or navigates away)
			if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))) {
				this.logService.trace('[Qwen3CompletionProvider] Request cancelled');
				return null;
			}

			this.logService.error(error instanceof Error ? error : new Error(String(error)), '[Qwen3CompletionProvider] Error providing completions');
			return null;
		}
	}

	private async _provideInlineCompletionItems(
		document: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<InlineCompletionItem[] | null> {
		const startTime = Date.now();

		// Get text before and after cursor
		const fullText = document.getText();
		const offset = document.offsetAt(position);
		const prefix = fullText.substring(0, offset);
		const suffix = fullText.substring(offset);

		// Build prompt for completion
		const prompt = this.buildPrompt(document, prefix, suffix);

		// Create AbortController for cancellation
		const abortController = new AbortController();
		const abortListener = token.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			// Make request to Qwen3 API
			// Note: For completions endpoint, use 'qwen-coder-turbo' instead of 'qwen3-coder-plus'
			// The chat endpoint uses different model names than the completions endpoint
			const requestBody = {
				model: 'qwen-coder-turbo',
				prompt: prompt,
				max_tokens: 200,
				temperature: 0.2,
				stop: ['\n\n', '```'],
			};

			this.logService.debug(`[Qwen3CompletionProvider] Requesting completion at ${document.uri.toString()}:${position.line}:${position.character}`);

			const response = await this.fetcherService.fetch(`${this.baseUrl}/completions`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
				signal: abortController.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				this.logService.error(`[Qwen3CompletionProvider] API error: ${response.status} ${errorText}`);
				return null;
			}

			const jsonResponse = await response.json();
			const completion = jsonResponse?.choices?.[0]?.text;

			if (!completion) {
				this.logService.debug('[Qwen3CompletionProvider] No completion returned');
				return null;
			}

			const latency = Date.now() - startTime;
			this.logService.debug(`[Qwen3CompletionProvider] Completion received in ${latency}ms: "${completion.substring(0, 50)}..."`);

			// Create inline completion item
			const item = new InlineCompletionItem(
				completion,
				new Range(position, position)
			);

			return [item];

		} finally {
			abortListener.dispose();
		}
	}

	private buildPrompt(document: TextDocument, prefix: string, suffix: string): string {
		// Build a completion prompt
		// Get last few lines of context (up to 500 chars)
		const contextLength = 500;
		const contextPrefix = prefix.length > contextLength
			? prefix.substring(prefix.length - contextLength)
			: prefix;

		// Simple prompt format for code completion
		return `<|fim_prefix|>${contextPrefix}<|fim_suffix|>${suffix.substring(0, 100)}<|fim_middle|>`;
	}
}
