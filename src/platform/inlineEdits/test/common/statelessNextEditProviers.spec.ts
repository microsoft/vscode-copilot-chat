/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { LineReplacement } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { LineRange } from '../../../../util/vs/editor/common/core/ranges/lineRange';
import { IgnoreWhitespaceOnlyChanges } from '../../common/statelessNextEditProviders';

describe('IgnoreFormattingChangesAspect', () => {
	// Helper to create test cases with less boilerplate
	function createEdit(baseLines: string[], newLines: string[]): LineReplacement {
		return new LineReplacement(new LineRange(1, baseLines.length + 1), newLines);
	}

	function isFormattingOnly(base: string[], edited: string[]): boolean {
		return IgnoreWhitespaceOnlyChanges._isFormattingOnlyChange(base, createEdit(base, edited));
	}

	// Test the core algorithm: formatting-only changes preserve content after whitespace removal
	it('identifies formatting vs content changes correctly', () => {
		// Formatting-only: content identical after removing whitespace
		expect(isFormattingOnly(['x=1;'], ['x = 1;'])).toBe(true);
		expect(isFormattingOnly(['  x'], ['x'])).toBe(true);
		expect(isFormattingOnly(['a', 'b'], ['a b'])).toBe(true);

		// Content changes: content differs after removing whitespace
		expect(isFormattingOnly(['x=1;'], ['x=2;'])).toBe(false);
		expect(isFormattingOnly(['x'], ['x+1'])).toBe(false);
		expect(isFormattingOnly(['a'], ['a', 'b'])).toBe(false);
	});

	// Representative examples of common scenarios
	describe('common scenarios', () => {
		const testCases = [
			// Formatting-only changes
			{ name: 'indentation', base: ['  code'], edited: ['    code'], expected: true },
			{ name: 'space normalization', base: ['a  b'], edited: ['a b'], expected: true },
			{ name: 'line breaks', base: ['a;', 'b;'], edited: ['a; b;'], expected: true },
			{ name: 'empty lines', base: ['   '], edited: ['\t'], expected: true },

			// Content changes
			{ name: 'value change', base: ['x=1'], edited: ['x=2'], expected: false },
			{ name: 'added code', base: ['f()'], edited: ['f()', 'g()'], expected: false },
			{ name: 'removed code', base: ['a', 'b'], edited: ['a'], expected: false },
		];

		it.each(testCases)('$name', ({ base, edited, expected }) => {
			expect(isFormattingOnly(base, edited)).toBe(expected);
		});
	});

	// Edge cases that could break the algorithm
	describe('edge cases', () => {
		it('handles empty content correctly', () => {
			expect(isFormattingOnly([''], [''])).toBe(true);
			expect(isFormattingOnly([''], ['   '])).toBe(true);
			expect(isFormattingOnly(['   '], [''])).toBe(true);
		});

		it('handles single character changes', () => {
			expect(isFormattingOnly(['a'], ['a '])).toBe(true);
			expect(isFormattingOnly(['a'], ['b'])).toBe(false);
		});
	});
});
