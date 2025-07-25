/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, beforeEach, suite, test } from 'vitest';
import { ThinkingData } from '../../common/thinking';
import { ThinkingDataImpl } from '../../node/thinkingDataService';

suite('ThinkingDataService', () => {
	let thinkingDataService: ThinkingDataImpl;

	beforeEach(() => {
		thinkingDataService = new ThinkingDataImpl();
	});

	suite('update', () => {
		test('should add new thinking data', () => {
			const thinkingData: ThinkingData = {
				cot_id: 'test-id',
				cot_summary: 'test summary'
			};

			thinkingDataService.update({
				message: thinkingData,
				index: 0
			}, 'tool-call-id');

			const result = thinkingDataService.consume('tool-call-id');
			assert.strictEqual(result?.cot_id, 'test-id');
			assert.strictEqual(result?.cot_summary, 'test summary');
		});

		test('should handle delta updates for cot_summary', () => {
			// Initial update
			thinkingDataService.update({
				message: {
					cot_id: 'test-id',
					cot_summary: 'initial '
				},
				index: 0
			});

			// Update with delta
			thinkingDataService.update({
				delta: {
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-call-id');

			const result = thinkingDataService.consume('tool-call-id');
			assert.strictEqual(result?.cot_id, 'test-id');
			assert.strictEqual(result?.cot_summary, 'initial summary');
		});

		test('should handle delta updates for reasoning_text', () => {
			// Initial update
			thinkingDataService.update({
				message: {
					reasoning_opaque: 'opaque-id',
					reasoning_text: 'thinking '
				},
				index: 0
			});

			// Update with delta and provide tool call ID
			thinkingDataService.update({
				delta: {
					reasoning_text: 'process'
				},
				index: 0
			}, 'tool-call-id');

			const result = thinkingDataService.consume('tool-call-id');
			assert.strictEqual(result?.reasoning_opaque, 'opaque-id');
			assert.strictEqual(result?.reasoning_text, 'thinking process');
		});

		test('should handle multiple choices with different indices', () => {
			// Add first choice with tool ID
			thinkingDataService.update({
				message: {
					cot_id: 'id1',
					cot_summary: 'summary1'
				},
				index: 0
			}, 'tool1');

			// Add second choice with tool ID
			thinkingDataService.update({
				message: {
					cot_id: 'id2',
					cot_summary: 'summary2'
				},
				index: 1
			}, 'tool2');

			const result1 = thinkingDataService.consume('tool1');
			const result2 = thinkingDataService.consume('tool2');

			assert.strictEqual(result1?.cot_id, 'id1');
			assert.strictEqual(result1?.cot_summary, 'summary1');
			assert.strictEqual(result2?.cot_id, 'id2');
			assert.strictEqual(result2?.cot_summary, 'summary2');
		});
	});

	// updateId functionality is now merged into update method with toolCallId parameter

	suite('consume', () => {
		test('should return undefined for non-existent id', () => {
			const result = thinkingDataService.consume('non-existent');
			assert.strictEqual(result, undefined);
		});

		test('should return cot_id when available', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.deepStrictEqual(result, {
				cot_id: 'cot-id',
				cot_summary: 'summary'
			});
		});

		test('should return reasoning_opaque when available', () => {
			thinkingDataService.update({
				message: {
					reasoning_opaque: 'opaque-id',
					reasoning_text: 'reasoning'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.deepStrictEqual(result, {
				reasoning_opaque: 'opaque-id',
				reasoning_text: 'reasoning'
			});
		});

		test('should not include choice_index in the result', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id') as any;
			assert.strictEqual(result.choice_index, undefined);
		});
	});

	suite('clear', () => {
		test('should clear all data', () => {
			// Add some thinking data with tool ID
			thinkingDataService.update({
				message: {
					cot_id: 'id1',
					cot_summary: 'summary1'
				},
				index: 0
			}, 'tool1');

			// Verify data exists
			let result = thinkingDataService.consume('tool1');
			assert.strictEqual(result?.cot_id, 'id1');

			// Clear the data
			thinkingDataService.clear();

			// Verify data is gone
			result = thinkingDataService.consume('tool1');
			assert.strictEqual(result, undefined);
		});
	});

	suite('extractThinkingData', () => {
		test('should extract cot data from message', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.strictEqual(result?.cot_id, 'cot-id');
			assert.strictEqual(result?.cot_summary, 'summary');
		});

		test('should extract cot data from delta', () => {
			thinkingDataService.update({
				delta: {
					cot_id: 'cot-id',
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.strictEqual(result?.cot_id, 'cot-id');
			assert.strictEqual(result?.cot_summary, 'summary');
		});

		test('should extract reasoning data from message', () => {
			thinkingDataService.update({
				message: {
					reasoning_opaque: 'opaque-id',
					reasoning_text: 'reasoning'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.strictEqual(result?.reasoning_opaque, 'opaque-id');
			assert.strictEqual(result?.reasoning_text, 'reasoning');
		});

		test('should extract reasoning data from delta', () => {
			thinkingDataService.update({
				delta: {
					reasoning_opaque: 'opaque-id',
					reasoning_text: 'reasoning'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.strictEqual(result?.reasoning_opaque, 'opaque-id');
			assert.strictEqual(result?.reasoning_text, 'reasoning');
		});

		test('should handle empty update', () => {
			thinkingDataService.update({
				message: {},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');
			assert.strictEqual(result, undefined);
		});
	});

	suite('edge cases', () => {
		test('should handle undefined reasoning_text or cot_summary', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: undefined
				},
				index: 0
			});

			thinkingDataService.update({
				delta: {
					cot_summary: 'summary'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');

			assert.strictEqual(result?.cot_id, 'cot-id');
			assert.strictEqual(result?.cot_summary, 'summary');
		});

		test('should return undefined reasoning_text or cot_summary', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: undefined
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');

			assert.strictEqual(result?.cot_summary, undefined);
		});

		test('should handle both cot and reasoning data in the same choice (prefers cot)', () => {
			thinkingDataService.update({
				message: {
					cot_id: 'cot-id',
					cot_summary: 'summary',
					reasoning_opaque: 'opaque-id',
					reasoning_text: 'reasoning'
				},
				index: 0
			}, 'tool-id');

			const result = thinkingDataService.consume('tool-id');

			// The implementation prioritizes cot_id
			assert.strictEqual(result?.cot_id, 'cot-id');
			assert.strictEqual(result?.cot_summary, 'summary');
			assert.strictEqual(result?.reasoning_opaque, undefined);
			assert.strictEqual(result?.reasoning_text, undefined);
		});
	});
});
