/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import { buildMultiReviewPrompt } from '../multiReview';
import type { MultiReviewConfig } from '../multiReviewUI';

suite('multiReview', () => {

	describe('buildMultiReviewPrompt', () => {

		function createConfig(overrides?: Partial<MultiReviewConfig>): MultiReviewConfig {
			return {
				scope: { type: 'uncommitted' },
				reviewers: [
					{ modelId: 'model-1', modelName: 'GPT-4', guideline: 'Focus on security' },
					{ modelId: 'model-2', modelName: 'Claude', guideline: 'Focus on architecture' },
				],
				...overrides,
			};
		}

		test('includes all reviewer names and guidelines', () => {
			const config = createConfig();
			const prompt = buildMultiReviewPrompt(config, 'diff content');

			assert.ok(prompt.includes('**GPT-4**'));
			assert.ok(prompt.includes('**Claude**'));
			assert.ok(prompt.includes('Focus on security'));
			assert.ok(prompt.includes('Focus on architecture'));
		});

		test('includes diff content in a code block', () => {
			const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';
			const prompt = buildMultiReviewPrompt(createConfig(), diff);

			assert.ok(prompt.includes('```diff'));
			assert.ok(prompt.includes(diff));
			assert.ok(prompt.includes('```'));
		});

		test('shows uncommitted scope description', () => {
			const config = createConfig({ scope: { type: 'uncommitted' } });
			const prompt = buildMultiReviewPrompt(config, 'diff');

			assert.ok(prompt.includes('All uncommitted changes'));
		});

		test('shows branch comparison scope description', () => {
			const config = createConfig({ scope: { type: 'branch', targetBranch: 'main' } });
			const prompt = buildMultiReviewPrompt(config, 'diff');

			assert.ok(prompt.includes('`main`'));
			assert.ok(prompt.includes('Current branch compared against'));
		});

		test('numbers reviewers sequentially', () => {
			const config = createConfig({
				reviewers: [
					{ modelId: 'm1', modelName: 'Model A', guideline: 'g1' },
					{ modelId: 'm2', modelName: 'Model B', guideline: 'g2' },
					{ modelId: 'm3', modelName: 'Model C', guideline: 'g3' },
				],
			});
			const prompt = buildMultiReviewPrompt(config, 'diff');

			assert.ok(prompt.includes('1. **Model A**'));
			assert.ok(prompt.includes('2. **Model B**'));
			assert.ok(prompt.includes('3. **Model C**'));
		});

		test('includes instructions for structured output', () => {
			const prompt = buildMultiReviewPrompt(createConfig(), 'diff');

			assert.ok(prompt.includes('Findings'));
			assert.ok(prompt.includes('Severity'));
			assert.ok(prompt.includes('Recommendations'));
			assert.ok(prompt.includes('Consolidated Summary'));
		});

		test('works with a single reviewer', () => {
			const config = createConfig({
				reviewers: [
					{ modelId: 'm1', modelName: 'Solo Model', guideline: 'Review everything' },
				],
			});
			const prompt = buildMultiReviewPrompt(config, 'diff');

			assert.ok(prompt.includes('1. **Solo Model**'));
			assert.ok(!prompt.includes('2.'));
		});
	});
});
