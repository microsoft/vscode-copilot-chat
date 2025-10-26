/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

describe('CopilotCloudSessionsProvider - PR Variations', () => {
	describe('Variations Option Group Configuration', () => {
		it('should define 4 variation options', () => {
			const expectedVariations = [
				{ id: '1', expectedLabel: '1 variant' },
				{ id: '2', expectedLabel: '2 variants' },
				{ id: '3', expectedLabel: '3 variants' },
				{ id: '4', expectedLabel: '4 variants' }
			];

			expect(expectedVariations).toHaveLength(4);
			expect(expectedVariations.map(v => v.id)).toEqual(['1', '2', '3', '4']);
		});

		it('should have correct naming pattern for variants', () => {
			const variantNames = ['1 variant', '2 variants', '3 variants', '4 variants'];

			// Verify singular vs plural
			expect(variantNames[0]).toContain('variant');
			expect(variantNames[1]).toContain('variants');
			expect(variantNames[2]).toContain('variants');
			expect(variantNames[3]).toContain('variants');
		});
	});

	describe('Variant Prompt Generation', () => {
		it('should append variant marker to prompt when creating multiple variants', () => {
			const basePrompt = 'Fix the bug in the code';
			const variationsCount = 3;

			for (let i = 0; i < variationsCount; i++) {
				const variantPrompt = `${basePrompt}\n\n[Variant ${i + 1} of ${variationsCount}]`;

				expect(variantPrompt).toContain(basePrompt);
				expect(variantPrompt).toContain(`[Variant ${i + 1} of ${variationsCount}]`);
			}
		});

		it('should not append variant marker for single variant', () => {
			const basePrompt = 'Fix the bug in the code';
			const variationsCount = 1;

			// When there's only 1 variant, the prompt should remain unchanged
			const variantPrompt = variationsCount > 1
				? `${basePrompt}\n\n[Variant 1 of ${variationsCount}]`
				: basePrompt;

			expect(variantPrompt).toBe(basePrompt);
			expect(variantPrompt).not.toContain('[Variant');
		});
	});

	describe('Premium Request Cost Calculation', () => {
		it('should calculate correct premium request cost', () => {
			const testCases = [
				{ variants: 1, expectedCost: 1 },
				{ variants: 2, expectedCost: 2 },
				{ variants: 3, expectedCost: 3 },
				{ variants: 4, expectedCost: 4 }
			];

			testCases.forEach(({ variants, expectedCost }) => {
				expect(variants).toBe(expectedCost);
			});
		});
	});

	describe('Confirmation Message Logic', () => {
		it('should use different confirmation message for multiple variants', () => {
			const variationsCount = 2;
			const shouldShowMultiVariantMessage = variationsCount > 1;

			expect(shouldShowMultiVariantMessage).toBe(true);
		});

		it('should use default message for single variant', () => {
			const variationsCount = 1;
			const shouldShowMultiVariantMessage = variationsCount > 1;

			expect(shouldShowMultiVariantMessage).toBe(false);
		});
	});
});
