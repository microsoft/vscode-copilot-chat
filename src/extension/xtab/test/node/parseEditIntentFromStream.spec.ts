/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { EditIntent, AggressivenessLevel } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { AsyncIterableObject } from '../../../../util/vs/base/common/async';
import { parseEditIntentFromStream } from '../../node/xtabProvider';
import { ILogger } from '../../../../platform/log/common/logService';

function createMockLogger(): ILogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
		flush: vi.fn(),
		createSubLogger: () => createMockLogger(),
		withContext: () => createMockLogger(),
	} as unknown as ILogger;
}

async function collectStream(stream: AsyncIterableObject<string>): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of stream) {
		lines.push(line);
	}
	return lines;
}

describe('parseEditIntentFromStream', () => {
	describe('parsing edit intent from stream', () => {
		it('should parse no_edit intent and return empty remaining stream', async () => {
			const inputLines = ['<|edit_intent|>no_edit<|/edit_intent|>', 'line1', 'line2'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(parseError).toBeUndefined();

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['line1', 'line2']);
		});

		it('should parse low intent and return remaining stream', async () => {
			const inputLines = ['<|edit_intent|>low<|/edit_intent|>', 'const x = 1;', 'const y = 2;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Low);
			expect(parseError).toBeUndefined();

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['const x = 1;', 'const y = 2;']);
		});

		it('should parse medium intent and return remaining stream', async () => {
			const inputLines = ['<|edit_intent|>medium<|/edit_intent|>', 'code here'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Medium);
			expect(parseError).toBeUndefined();

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['code here']);
		});

		it('should parse high intent and return remaining stream', async () => {
			const inputLines = ['<|edit_intent|>high<|/edit_intent|>', 'line1', 'line2', 'line3'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBeUndefined();

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['line1', 'line2', 'line3']);
		});

		it('should handle content on same line after tag', async () => {
			const inputLines = ['<|edit_intent|>low<|/edit_intent|>const x = 1;', 'const y = 2;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Low);
			expect(parseError).toBeUndefined();

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['const x = 1;', 'const y = 2;']);
		});

		it('should handle whitespace-only content after tag (trimmed)', async () => {
			const inputLines = ['<|edit_intent|>low<|/edit_intent|>   ', 'const x = 1;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Low);
			expect(parseError).toBeUndefined();

			// Whitespace-only content after tag is trimmed and not emitted
			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['const x = 1;']);
		});
	});

	describe('parse errors and defaults', () => {
		it('should default to High when empty stream', async () => {
			const linesStream = AsyncIterableObject.fromArray([]);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBe('emptyResponse');

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual([]);
		});

		it('should default to High and return all lines when no tag found', async () => {
			const inputLines = ['const x = 1;', 'const y = 2;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBe('noTagFound');

			// All original lines should be in remaining stream when no tag found
			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['const x = 1;', 'const y = 2;']);
		});

		it('should return error for start tag without end tag', async () => {
			const inputLines = ['<|edit_intent|>low', 'const x = 1;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBe('malformedTag:startWithoutEnd');

			// All original lines should be in remaining stream
			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['<|edit_intent|>low', 'const x = 1;']);
		});

		it('should return error for end tag without start tag', async () => {
			const inputLines = ['low<|/edit_intent|>', 'const x = 1;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBe('malformedTag:endWithoutStart');

			// All original lines should be in remaining stream
			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['low<|/edit_intent|>', 'const x = 1;']);
		});

		it('should handle unknown intent value and default to High', async () => {
			const inputLines = ['<|edit_intent|>unknown_value<|/edit_intent|>', 'const x = 1;'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBeUndefined(); // Tag was parsed, just unknown value

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['const x = 1;']);
		});
	});

	describe('short-circuit scenarios', () => {
		// These tests verify the filtering behavior that would cause short-circuiting
		// in the streamEdits method

		it('no_edit intent with Low aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>no_edit<|/edit_intent|>', 'code that would be edited'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(false);
		});

		it('no_edit intent with Medium aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>no_edit<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(false);
		});

		it('no_edit intent with High aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>no_edit<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
		});

		it('high intent with Medium aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>high<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(false);
		});

		it('high intent with High aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>high<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
		});

		it('low intent should never be filtered (no short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>low<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Low);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(true);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(true);
		});

		it('medium intent with High aggressiveness should be filtered (short-circuit)', async () => {
			const inputLines = ['<|edit_intent|>medium<|/edit_intent|>', 'code'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Medium);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(true);
			expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
		});
	});

	describe('stream consumption', () => {
		it('should correctly consume entire stream when tag is present', async () => {
			const inputLines = ['<|edit_intent|>low<|/edit_intent|>', 'a', 'b', 'c', 'd', 'e'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.Low);

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['a', 'b', 'c', 'd', 'e']);
		});

		it('should correctly consume entire stream when no tag is present', async () => {
			const inputLines = ['a', 'b', 'c'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream, parseError } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.High);
			expect(parseError).toBe('noTagFound');

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual(['a', 'b', 'c']);
		});

		it('should handle single-line stream with only tag', async () => {
			const inputLines = ['<|edit_intent|>no_edit<|/edit_intent|>'];
			const linesStream = AsyncIterableObject.fromArray(inputLines);
			const logger = createMockLogger();

			const { editIntent, remainingLinesStream } = await parseEditIntentFromStream(linesStream, logger);

			expect(editIntent).toBe(EditIntent.NoEdit);

			const remainingLines = await collectStream(remainingLinesStream);
			expect(remainingLines).toEqual([]);
		});
	});
});
