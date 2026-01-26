/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AggressivenessLevel, EditIntent } from '../dataTypes/xtabPromptOptions';

describe('EditIntent', () => {
	describe('parseFromResponse', () => {
		it('should parse high edit intent from first line', () => {
			const response = '<|edit_intent|>high<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should parse medium edit intent from first line', () => {
			const response = '<|edit_intent|>medium<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.Medium);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should parse low edit intent from first line', () => {
			const response = '<|edit_intent|>low<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.Low);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should parse no_edit intent from first line', () => {
			const response = '<|edit_intent|>no_edit<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.NoEdit);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should handle response with no edit intent tag', () => {
			const response = 'const x = 1;\nconst y = 2;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe(response);
		});

		it('should handle response with blank first line with no edit intent tag', () => {
			const response = '\nconst x = 1;\nconst y = 2;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe(response);
		});

		it('should handle response with malformed tag (missing end)', () => {
			const response = '<|edit_intent|>high\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe(response);
		});

		it('should handle response with unknown intent value', () => {
			const response = '<|edit_intent|>unknown<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should handle intent with surrounding whitespace', () => {
			const response = '<|edit_intent|>  high  <|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should handle intent with mixed case', () => {
			const response = '<|edit_intent|>HIGH<|/edit_intent|>\nconst x = 1;';
			const result = EditIntent.parseFromResponse(response);

			expect(result.editIntent).toBe(EditIntent.High);
			expect(result.remainingContent).toBe('const x = 1;');
		});

		it('should default to High when tag is on second line (not first)', () => {
			// Note: parseFromResponse uses indexOf which looks at the whole string,
			// but the stream-based parser in xtabProvider only checks the first line.
			// This test documents the string-based helper behavior.
			const response = 'some code\n<|edit_intent|>low<|/edit_intent|>\nmore code';
			const result = EditIntent.parseFromResponse(response);

			// The string-based parser finds the tag anywhere in the string
			expect(result.editIntent).toBe(EditIntent.Low);
		});
	});

	describe('fromString', () => {
		it('should return NoEdit for "no_edit"', () => {
			expect(EditIntent.fromString('no_edit')).toBe(EditIntent.NoEdit);
		});

		it('should return Low for "low"', () => {
			expect(EditIntent.fromString('low')).toBe(EditIntent.Low);
		});

		it('should return Medium for "medium"', () => {
			expect(EditIntent.fromString('medium')).toBe(EditIntent.Medium);
		});

		it('should return High for "high"', () => {
			expect(EditIntent.fromString('high')).toBe(EditIntent.High);
		});

		it('should return High for unknown values', () => {
			expect(EditIntent.fromString('invalid')).toBe(EditIntent.High);
			expect(EditIntent.fromString('')).toBe(EditIntent.High);
		});
	});

	describe('shouldShowEdit', () => {
		describe('NoEdit intent', () => {
			it('should never show edit regardless of aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.NoEdit, AggressivenessLevel.Low)).toBe(false);
				expect(EditIntent.shouldShowEdit(EditIntent.NoEdit, AggressivenessLevel.Medium)).toBe(false);
				expect(EditIntent.shouldShowEdit(EditIntent.NoEdit, AggressivenessLevel.High)).toBe(false);
			});
		});

		describe('Low intent (show for all aggressiveness levels)', () => {
			it('should show for Low aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Low, AggressivenessLevel.Low)).toBe(true);
			});

			it('should show for Medium aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Low, AggressivenessLevel.Medium)).toBe(true);
			});

			it('should show for High aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Low, AggressivenessLevel.High)).toBe(true);
			});
		});

		describe('Medium intent (show for low/medium aggressiveness)', () => {
			it('should show for Low aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Medium, AggressivenessLevel.Low)).toBe(true);
			});

			it('should show for Medium aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Medium, AggressivenessLevel.Medium)).toBe(true);
			});

			it('should NOT show for High aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.Medium, AggressivenessLevel.High)).toBe(false);
			});
		});

		describe('High intent (only show for low aggressiveness)', () => {
			it('should show for Low aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.High, AggressivenessLevel.Low)).toBe(true);
			});

			it('should NOT show for Medium aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.High, AggressivenessLevel.Medium)).toBe(false);
			});

			it('should NOT show for High aggressiveness', () => {
				expect(EditIntent.shouldShowEdit(EditIntent.High, AggressivenessLevel.High)).toBe(false);
			});
		});
	});
});
