/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AsyncIterableObject } from '../../../../util/vs/base/common/async';
import { toLines } from '../../node/xtabUtils';

describe('toLines', () => {

	async function chunksToLines(chunks: string[]) {
		const iter = AsyncIterableObject.fromArray(chunks.map(text => ({ delta: { text } })));
		const arr: string[] = [];
		for await (const line of toLines(iter)) {
			arr.push(line);
		}
		return arr;
	}

	describe('empty and minimal inputs', () => {
		it('handles empty stream', async () => {
			const arr = await chunksToLines([]);
			expect(arr).toEqual([]);
		});

		it('handles single empty chunk', async () => {
			const arr = await chunksToLines(['']);
			expect(arr).toEqual(['']);
		});

		it('handles multiple empty chunks', async () => {
			const arr = await chunksToLines(['', '', '']);
			expect(arr).toEqual(['']);
		});
	});

	describe('single chunk inputs', () => {
		it('handles single line without newline', async () => {
			const arr = await chunksToLines(['hello']);
			expect(arr).toEqual(['hello']);
		});

		it('handles single line with trailing newline', async () => {
			const arr = await chunksToLines(['hello\n']);
			expect(arr).toEqual(['hello', '']);
		});

		it('handles multiple lines in single chunk', async () => {
			const arr = await chunksToLines(['line1\nline2\nline3']);
			expect(arr).toEqual(['line1', 'line2', 'line3']);
		});

		it('handles multiple lines with trailing newline', async () => {
			const arr = await chunksToLines(['line1\nline2\nline3\n']);
			expect(arr).toEqual(['line1', 'line2', 'line3', '']);
		});
	});

	describe('multiple chunks', () => {
		it('handles each line as separate chunk', async () => {
			const arr = await chunksToLines(['line1\n', 'line2\n', 'line3']);
			expect(arr).toEqual(['line1', 'line2', 'line3']);
		});

		it('handles line split across two chunks', async () => {
			const arr = await chunksToLines(['hel', 'lo']);
			expect(arr).toEqual(['hello']);
		});

		it('handles line split across multiple chunks', async () => {
			const arr = await chunksToLines(['h', 'e', 'l', 'l', 'o']);
			expect(arr).toEqual(['hello']);
		});

		it('handles newline split between chunks', async () => {
			const arr = await chunksToLines(['line1', '\nline2']);
			expect(arr).toEqual(['line1', 'line2']);
		});

		it('handles complex split across chunks', async () => {
			const arr = await chunksToLines(['li', 'ne1\nli', 'ne2\n', 'line3']);
			expect(arr).toEqual(['line1', 'line2', 'line3']);
		});
	});

	describe('line endings', () => {
		it('handles Windows-style line endings (CRLF)', async () => {
			const arr = await chunksToLines(['line1\r\nline2\r\nline3']);
			expect(arr).toEqual(['line1', 'line2', 'line3']);
		});

		it('handles Windows-style line endings with trailing CRLF', async () => {
			const arr = await chunksToLines(['line1\r\nline2\r\n']);
			expect(arr).toEqual(['line1', 'line2', '']);
		});

		it('handles mixed line endings', async () => {
			const arr = await chunksToLines(['line1\nline2\r\nline3']);
			expect(arr).toEqual(['line1', 'line2', 'line3']);
		});

		it('handles CRLF split across chunks', async () => {
			const arr = await chunksToLines(['line1\r', '\nline2']);
			expect(arr).toEqual(['line1', 'line2']);
		});
	});

	describe('empty lines', () => {
		it('handles single empty line', async () => {
			const arr = await chunksToLines(['\n']);
			expect(arr).toEqual(['', '']);
		});

		it('handles multiple consecutive empty lines', async () => {
			const arr = await chunksToLines(['\n\n\n']);
			expect(arr).toEqual(['', '', '', '']);
		});

		it('handles empty lines between content', async () => {
			const arr = await chunksToLines(['line1\n\nline2']);
			expect(arr).toEqual(['line1', '', 'line2']);
		});

		it('handles multiple empty lines between content', async () => {
			const arr = await chunksToLines(['line1\n\n\nline2']);
			expect(arr).toEqual(['line1', '', '', 'line2']);
		});
	});

	describe('edge cases', () => {
		it('handles only newlines in separate chunks', async () => {
			const arr = await chunksToLines(['\n', '\n', '\n']);
			expect(arr).toEqual(['', '', '', '']);
		});

		it('handles chunk that is just a newline after content', async () => {
			const arr = await chunksToLines(['hello', '\n']);
			expect(arr).toEqual(['hello', '']);
		});

		it('handles whitespace-only lines', async () => {
			const arr = await chunksToLines(['  \n\t\n   ']);
			expect(arr).toEqual(['  ', '\t', '   ']);
		});

		it('handles unicode content', async () => {
			const arr = await chunksToLines(['héllo\nwörld\n日本語']);
			expect(arr).toEqual(['héllo', 'wörld', '日本語']);
		});

		it('handles emoji content', async () => {
			const arr = await chunksToLines(['👋\n🌍']);
			expect(arr).toEqual(['👋', '🌍']);
		});

		it('simulates character-by-character streaming', async () => {
			const text = 'ab\ncd';
			const arr = await chunksToLines(text.split(''));
			expect(arr).toEqual(['ab', 'cd']);
		});
	});
});
