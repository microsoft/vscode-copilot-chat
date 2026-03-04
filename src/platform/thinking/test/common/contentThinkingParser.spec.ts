/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { ContentThinkingParser } from '../../common/thinkingUtils';

suite('ContentThinkingParser', () => {

	test('chunk entirely within thinking', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('analyzing the problem');
		expect(result).toEqual({ thinking: 'analyzing the problem' });
		expect(parser.isInThinkingState()).toBe(true);
	});

	test('multiple chunks entirely within thinking', () => {
		const parser = new ContentThinkingParser();
		expect(parser.processChunk('step 1')).toEqual({ thinking: 'step 1' });
		expect(parser.processChunk(' step 2')).toEqual({ thinking: ' step 2' });
		expect(parser.isInThinkingState()).toBe(true);
	});

	test('chunk containing </think> boundary', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('last thought</think>hello world');
		expect(result).toEqual({ thinking: 'last thought', content: 'hello world' });
		expect(parser.isInThinkingState()).toBe(false);
	});

	test('chunk entirely after thinking', () => {
		const parser = new ContentThinkingParser();
		parser.processChunk('thought</think>');
		const result = parser.processChunk('real content');
		expect(result).toEqual({ content: 'real content' });
		expect(parser.isInThinkingState()).toBe(false);
	});

	test('</think> as the entire chunk', () => {
		const parser = new ContentThinkingParser();
		parser.processChunk('some thinking');
		const result = parser.processChunk('</think>');
		expect(result).toEqual({ thinking: undefined, content: undefined });
		expect(parser.isInThinkingState()).toBe(false);
	});

	test('strips <think> opening tag from first chunk', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('<think>analyzing');
		expect(result).toEqual({ thinking: 'analyzing' });
		expect(parser.isInThinkingState()).toBe(true);
	});

	test('strips <think> and finds </think> in same first chunk', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('<think>quick thought</think>answer');
		expect(result).toEqual({ thinking: 'quick thought', content: 'answer' });
		expect(parser.isInThinkingState()).toBe(false);
	});

	test('does not strip <think> from non-first chunk', () => {
		const parser = new ContentThinkingParser();
		parser.processChunk('first');
		// A second chunk shouldn't have its content treated as a tag
		const result = parser.processChunk('<think>more');
		expect(result).toEqual({ thinking: '<think>more' });
	});

	test('empty content chunk during thinking state', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('');
		expect(result).toEqual({ thinking: '' });
		expect(parser.isInThinkingState()).toBe(true);
	});

	test('empty content chunk after thinking done', () => {
		const parser = new ContentThinkingParser();
		parser.processChunk('</think>');
		const result = parser.processChunk('');
		expect(result).toEqual({ content: '' });
	});

	test('content after </think> boundary is passed through on subsequent chunks', () => {
		const parser = new ContentThinkingParser();
		parser.processChunk('thought</think>first part');
		expect(parser.processChunk(' second part')).toEqual({ content: ' second part' });
		expect(parser.processChunk(' third part')).toEqual({ content: ' third part' });
	});

	test('</think> with no thinking text before it', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('</think>answer');
		expect(result).toEqual({ thinking: undefined, content: 'answer' });
		expect(parser.isInThinkingState()).toBe(false);
	});

	test('<think></think> with immediate close', () => {
		const parser = new ContentThinkingParser();
		const result = parser.processChunk('<think></think>answer');
		expect(result).toEqual({ thinking: undefined, content: 'answer' });
		expect(parser.isInThinkingState()).toBe(false);
	});
});
