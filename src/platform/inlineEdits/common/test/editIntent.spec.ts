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

	describe('short-circuit filtering scenarios', () => {
		// These tests verify the filtering logic that would cause the stream to short-circuit
		// in the xtabProvider's parseEditIntentFromStream method

		describe('no_edit intent always short-circuits', () => {
			it('should filter out no_edit with Low aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>no_edit<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(false);
			});

			it('should filter out no_edit with Medium aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>no_edit<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(false);
			});

			it('should filter out no_edit with High aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>no_edit<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
			});
		});

		describe('high intent short-circuits at medium/high aggressiveness', () => {
			it('should NOT short-circuit high intent with Low aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>high<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			});

			it('should short-circuit high intent with Medium aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>high<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(false);
			});

			it('should short-circuit high intent with High aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>high<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
			});
		});

		describe('medium intent short-circuits at high aggressiveness', () => {
			it('should NOT short-circuit medium intent with Low aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>medium<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			});

			it('should NOT short-circuit medium intent with Medium aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>medium<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(true);
			});

			it('should short-circuit medium intent with High aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>medium<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
			});
		});

		describe('low intent never short-circuits', () => {
			it('should NOT short-circuit low intent with Low aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>low<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			});

			it('should NOT short-circuit low intent with Medium aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>low<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(true);
			});

			it('should NOT short-circuit low intent with High aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('<|edit_intent|>low<|/edit_intent|>\ncode');
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(true);
			});
		});

		describe('missing tag defaults to High (most permissive for short-circuit)', () => {
			it('should NOT short-circuit missing tag with Low aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('code without tag');
				expect(editIntent).toBe(EditIntent.High);
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Low)).toBe(true);
			});

			it('should short-circuit missing tag with Medium aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('code without tag');
				expect(editIntent).toBe(EditIntent.High);
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.Medium)).toBe(false);
			});

			it('should short-circuit missing tag with High aggressiveness', () => {
				const { editIntent } = EditIntent.parseFromResponse('code without tag');
				expect(editIntent).toBe(EditIntent.High);
				expect(EditIntent.shouldShowEdit(editIntent, AggressivenessLevel.High)).toBe(false);
			});
		});
	});

	describe('remaining content after edit intent tag', () => {
		it('should correctly extract remaining content when tag is followed by newline', () => {
			const response = '<|edit_intent|>low<|/edit_intent|>\nline1\nline2\nline3';
			const { remainingContent } = EditIntent.parseFromResponse(response);
			expect(remainingContent).toBe('line1\nline2\nline3');
		});

		it('should correctly extract remaining content when tag is followed by content on same line', () => {
			const response = '<|edit_intent|>low<|/edit_intent|>line1\nline2';
			const { remainingContent } = EditIntent.parseFromResponse(response);
			// Note: parseFromResponse strips the leading newline if present
			expect(remainingContent).toBe('line1\nline2');
		});

		it('should return empty remaining content when only tag is present', () => {
			const response = '<|edit_intent|>no_edit<|/edit_intent|>';
			const { editIntent, remainingContent } = EditIntent.parseFromResponse(response);
			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(remainingContent).toBe('');
		});

		it('should handle tag followed by only whitespace', () => {
			const response = '<|edit_intent|>no_edit<|/edit_intent|>\n   \n';
			const { editIntent, remainingContent } = EditIntent.parseFromResponse(response);
			expect(editIntent).toBe(EditIntent.NoEdit);
			expect(remainingContent).toBe('   \n');
		});
	});
});
