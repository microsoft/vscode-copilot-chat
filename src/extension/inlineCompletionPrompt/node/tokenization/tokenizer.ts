/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TikTokenizer, createTokenizer, getRegexByEncoder, getSpecialTokensByEncoder } from '@microsoft/tiktokenizer';
import { parseTikTokenBinary } from '../../../../platform/tokenizer/node/parseTikTokens';
import { CopilotPromptLoadFailure } from '../../common/error';
import { ApproximateTokenizer, MockTokenizer, Tokenizer, TokenizerName } from '../../common/tokenization/tokenizer';
import { locateFile } from '../fileLoader';

const tokenizers = new Map<TokenizerName, Tokenizer>();

export function getTokenizer(name: TokenizerName = TokenizerName.o200k): Tokenizer {
	let tokenizer = tokenizers.get(name);
	if (tokenizer !== undefined) { return tokenizer; }
	// Fallback to o200k
	tokenizer = tokenizers.get(TokenizerName.o200k);
	if (tokenizer !== undefined) { return tokenizer; }
	// Fallback to approximate tokenizer
	return new ApproximateTokenizer();
}

export async function getTokenizerAsync(name: TokenizerName = TokenizerName.o200k): Promise<Tokenizer> {
	await initializeTokenizers;
	return getTokenizer(name);
}

export class TTokenizer implements Tokenizer {
	constructor(private readonly _tokenizer: TikTokenizer) { }

	static async create(encoder: TokenizerName): Promise<TTokenizer> {
		try {
			const tokenizer = createTokenizer(
				parseTikTokenBinary(locateFile(`${encoder}.tiktoken`)),
				getSpecialTokensByEncoder(encoder),
				getRegexByEncoder(encoder),
				32768
			);
			return new TTokenizer(tokenizer);
		} catch (e: unknown) {
			if (e instanceof Error) {
				throw new CopilotPromptLoadFailure(`Could not load tokenizer`, e);
			}
			throw e;
		}
	}

	tokenize(text: string): number[] {
		return this._tokenizer.encode(text);
	}

	detokenize(tokens: number[]): string {
		return this._tokenizer.decode(tokens);
	}

	tokenLength(text: string): number {
		return this.tokenize(text).length;
	}

	tokenizeStrings(text: string): string[] {
		const tokens = this.tokenize(text);
		return tokens.map(token => this.detokenize([token]));
	}

	takeLastTokens(text: string, n: number): { text: string; tokens: number[] } {
		if (n <= 0) { return { text: '', tokens: [] }; }

		// Find long enough suffix of text that has >= n + 2 tokens
		// We add the 2 extra tokens to avoid the edge case where
		// we cut at exactly n tokens and may get an odd tokenization.
		const CHARS_PER_TOKENS_START = 4;
		const CHARS_PER_TOKENS_ADD = 1;
		let chars = Math.min(text.length, n * CHARS_PER_TOKENS_START); //First guess
		let suffix = text.slice(-chars);
		let suffixT = this.tokenize(suffix);
		while (suffixT.length < n + 2 && chars < text.length) {
			chars = Math.min(text.length, chars + n * CHARS_PER_TOKENS_ADD);
			suffix = text.slice(-chars);
			suffixT = this.tokenize(suffix);
		}
		if (suffixT.length < n) {
			// text must be <= n tokens long
			return { text, tokens: suffixT };
		}
		// Return last n tokens
		suffixT = suffixT.slice(-n);
		return { text: this.detokenize(suffixT), tokens: suffixT };
	}

	takeFirstTokens(text: string, n: number): { text: string; tokens: number[] } {
		if (n <= 0) { return { text: '', tokens: [] }; }

		// Find long enough suffix of text that has >= n + 2 tokens
		// We add the 2 extra tokens to avoid the edge case where
		// we cut at exactly n tokens and may get an odd tokenization.
		const CHARS_PER_TOKENS_START = 4;
		const CHARS_PER_TOKENS_ADD = 1;
		let chars = Math.min(text.length, n * CHARS_PER_TOKENS_START); //First guess
		let prefix = text.slice(0, chars);
		let prefix_t = this.tokenize(prefix);
		while (prefix_t.length < n + 2 && chars < text.length) {
			chars = Math.min(text.length, chars + n * CHARS_PER_TOKENS_ADD);
			prefix = text.slice(0, chars);
			prefix_t = this.tokenize(prefix);
		}
		if (prefix_t.length < n) {
			// text must be <= n tokens long
			return {
				text: text,
				tokens: prefix_t,
			};
		}
		// Return first n tokens
		// This implicit "truncate final tokens" text processing algorithm
		// could be extracted into a generic snippet text processing function managed by the SnippetTextProcessor class.
		prefix_t = prefix_t.slice(0, n);
		return {
			text: this.detokenize(prefix_t),
			tokens: prefix_t,
		};
	}

	takeLastLinesTokens(text: string, n: number): string {
		const { text: suffix } = this.takeLastTokens(text, n);
		if (suffix.length === text.length || text[text.length - suffix.length - 1] === '\n') {
			// Edge case: We already took whole lines
			return suffix;
		}
		const newline = suffix.indexOf('\n');
		return suffix.substring(newline + 1);
	}
}

async function setTokenizer(name: TokenizerName) {
	try {
		const tokenizer = await TTokenizer.create(name);
		tokenizers.set(name, tokenizer);
	} catch {
		// Ignore errors loading tokenizer
	}
}

/** Load tokenizers on start. Export promise for to be awaited by initialization. */
export const initializeTokenizers = (async () => {
	tokenizers.set(TokenizerName.mock, new MockTokenizer());
	await Promise.all([setTokenizer(TokenizerName.cl100k), setTokenizer(TokenizerName.o200k)]);
})();
