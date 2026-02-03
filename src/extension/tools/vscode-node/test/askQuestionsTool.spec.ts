/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { AskQuestionsTool } from '../askQuestionsTool';

interface IQuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

interface IQuestion {
	header: string;
	question: string;
	multiSelect?: boolean;
	options?: IQuestionOption[];
}

interface IQuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

interface IAnswerResult {
	answers: Record<string, IQuestionAnswer>;
}

/**
 * Test subclass that exposes protected methods for testing
 */
class TestableAskQuestionsTool extends AskQuestionsTool {
	public testConvertCarouselAnswers(questions: IQuestion[], carouselAnswers: Record<string, unknown> | undefined): IAnswerResult {
		return this._convertCarouselAnswers(questions, carouselAnswers);
	}
}

describe('AskQuestionsTool - _convertCarouselAnswers', () => {
	let tool: TestableAskQuestionsTool;

	beforeEach(() => {
		tool = new TestableAskQuestionsTool(
			new NullTelemetryService(),
			new TestLogService()
		);
	});

	describe('when carouselAnswers is undefined', () => {
		test('marks all questions as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'First question?' },
				{ header: 'Q2', question: 'Second question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, undefined);

			expect(result.answers['Q1']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
			expect(result.answers['Q2']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});
	});

	describe('when answer is undefined for a question', () => {
		test('marks that question as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'First question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {});

			expect(result.answers['Q1']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});

		test('handles partial answers - some answered, some missing', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
				{ header: 'Q2', question: 'Second?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': { selectedValue: 'Yes' }
				// Q2 is missing
			});

			expect(result.answers['Q1'].skipped).toBe(false);
			expect(result.answers['Q1'].selected).toEqual(['Yes']);
			expect(result.answers['Q2'].skipped).toBe(true);
		});
	});

	describe('when answer is a string', () => {
		test('treats matching option as single selection', () => {
			const questions: IQuestion[] = [
				{
					header: 'Color',
					question: 'Pick a color',
					options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, { 'Color': 'Blue' });

			expect(result.answers['Color']).toEqual({
				selected: ['Blue'],
				freeText: null,
				skipped: false
			});
		});

		test('treats non-matching string as free text', () => {
			const questions: IQuestion[] = [
				{
					header: 'Color',
					question: 'Pick a color',
					options: [{ label: 'Red' }, { label: 'Blue' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, { 'Color': 'Purple' });

			expect(result.answers['Color']).toEqual({
				selected: [],
				freeText: 'Purple',
				skipped: false
			});
		});

		test('treats string as free text when no options defined', () => {
			const questions: IQuestion[] = [
				{ header: 'Name', question: 'What is your name?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, { 'Name': 'Alice' });

			expect(result.answers['Name']).toEqual({
				selected: [],
				freeText: 'Alice',
				skipped: false
			});
		});

		test('handles empty string as free text', () => {
			const questions: IQuestion[] = [
				{ header: 'Comment', question: 'Any comments?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, { 'Comment': '' });

			expect(result.answers['Comment']).toEqual({
				selected: [],
				freeText: '',
				skipped: false
			});
		});
	});

	describe('when answer is an array', () => {
		test('handles multi-select with string array', () => {
			const questions: IQuestion[] = [
				{
					header: 'Colors',
					question: 'Pick colors',
					multiSelect: true,
					options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Colors': ['Red', 'Green']
			});

			expect(result.answers['Colors']).toEqual({
				selected: ['Red', 'Green'],
				freeText: null,
				skipped: false
			});
		});

		test('converts non-string array elements to strings', () => {
			const questions: IQuestion[] = [
				{ header: 'Numbers', question: 'Pick numbers', multiSelect: true }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Numbers': [1, 2, 3]
			});

			expect(result.answers['Numbers']).toEqual({
				selected: ['1', '2', '3'],
				freeText: null,
				skipped: false
			});
		});

		test('handles empty array', () => {
			const questions: IQuestion[] = [
				{ header: 'Items', question: 'Select items', multiSelect: true }
			];

			const result = tool.testConvertCarouselAnswers(questions, { 'Items': [] });

			expect(result.answers['Items']).toEqual({
				selected: [],
				freeText: null,
				skipped: false
			});
		});
	});

	describe('when answer is an object with selectedValue (VS Code format)', () => {
		test('handles single select with matching option', () => {
			const questions: IQuestion[] = [
				{
					header: 'Range',
					question: 'Use range?',
					options: [{ label: 'Yes' }, { label: 'No' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Range': { selectedValue: 'Yes' }
			});

			expect(result.answers['Range']).toEqual({
				selected: ['Yes'],
				freeText: null,
				skipped: false
			});
		});

		test('handles single select with non-matching value as free text', () => {
			const questions: IQuestion[] = [
				{
					header: 'Choice',
					question: 'Pick one',
					options: [{ label: 'A' }, { label: 'B' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Choice': { selectedValue: 'Custom answer' }
			});

			expect(result.answers['Choice']).toEqual({
				selected: [],
				freeText: 'Custom answer',
				skipped: false
			});
		});

		test('handles selectedValue with array value', () => {
			const questions: IQuestion[] = [
				{
					header: 'Multi',
					question: 'Pick many',
					multiSelect: true,
					options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Multi': { selectedValue: ['X', 'Z'] }
			});

			expect(result.answers['Multi']).toEqual({
				selected: ['X', 'Z'],
				freeText: null,
				skipped: false
			});
		});

		test('handles free text question with selectedValue', () => {
			const questions: IQuestion[] = [
				{ header: 'Feedback', question: 'Enter feedback' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Feedback': { selectedValue: 'Great tool!' }
			});

			expect(result.answers['Feedback']).toEqual({
				selected: [],
				freeText: 'Great tool!',
				skipped: false
			});
		});
	});

	describe('when answer is an object with selectedValues (VS Code multi-select format)', () => {
		test('handles multi-select answers', () => {
			const questions: IQuestion[] = [
				{
					header: 'Features',
					question: 'Select features',
					multiSelect: true,
					options: [
						{ label: 'Dark mode' },
						{ label: 'Auto-save' },
						{ label: 'Spell check' }
					]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Features': { selectedValues: ['Dark mode', 'Spell check'] }
			});

			expect(result.answers['Features']).toEqual({
				selected: ['Dark mode', 'Spell check'],
				freeText: null,
				skipped: false
			});
		});

		test('handles empty selectedValues array', () => {
			const questions: IQuestion[] = [
				{ header: 'Options', question: 'Pick options', multiSelect: true }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Options': { selectedValues: [] }
			});

			expect(result.answers['Options']).toEqual({
				selected: [],
				freeText: null,
				skipped: false
			});
		});

		test('converts non-string selectedValues to strings', () => {
			const questions: IQuestion[] = [
				{ header: 'Nums', question: 'Pick numbers', multiSelect: true }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Nums': { selectedValues: [1, 2, 3] }
			});

			expect(result.answers['Nums']).toEqual({
				selected: ['1', '2', '3'],
				freeText: null,
				skipped: false
			});
		});
	});

	describe('when answer is an object with label property', () => {
		test('handles raw option object format', () => {
			const questions: IQuestion[] = [
				{
					header: 'Framework',
					question: 'Choose framework',
					options: [{ label: 'React' }, { label: 'Vue' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Framework': { label: 'React', id: 'react-id' }
			});

			expect(result.answers['Framework']).toEqual({
				selected: ['React'],
				freeText: null,
				skipped: false
			});
		});
	});

	describe('freeform text with options (allowFreeformInput scenarios)', () => {
		test('handles freeformValue only - no selection made', () => {
			const questions: IQuestion[] = [
				{
					header: 'Range',
					question: 'Use range?',
					options: [{ label: 'Yes' }, { label: 'No' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Range': { freeformValue: 'Maybe, depends on context' }
			});

			expect(result.answers['Range']).toEqual({
				selected: [],
				freeText: 'Maybe, depends on context',
				skipped: false
			});
		});

		test('handles freeformValue with null selectedValue', () => {
			const questions: IQuestion[] = [
				{
					header: 'Choice',
					question: 'Pick one',
					options: [{ label: 'A' }, { label: 'B' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Choice': { selectedValue: null, freeformValue: 'Neither, use C' }
			});

			expect(result.answers['Choice']).toEqual({
				selected: [],
				freeText: 'Neither, use C',
				skipped: false
			});
		});

		test('handles freeformValue with undefined selectedValue', () => {
			const questions: IQuestion[] = [
				{
					header: 'Option',
					question: 'Select option',
					options: [{ label: 'X' }, { label: 'Y' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Option': { selectedValue: undefined, freeformValue: 'Custom Z' }
			});

			expect(result.answers['Option']).toEqual({
				selected: [],
				freeText: 'Custom Z',
				skipped: false
			});
		});

		test('handles both selection and freeformValue', () => {
			const questions: IQuestion[] = [
				{
					header: 'Size',
					question: 'Pick size',
					options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Size': { selectedValue: 'Large', freeformValue: 'Actually make it extra large' }
			});

			expect(result.answers['Size']).toEqual({
				selected: ['Large'],
				freeText: 'Actually make it extra large',
				skipped: false
			});
		});

		test('handles multi-select with freeformValue', () => {
			const questions: IQuestion[] = [
				{
					header: 'Features',
					question: 'Select features',
					multiSelect: true,
					options: [{ label: 'Dark mode' }, { label: 'Auto-save' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Features': { selectedValues: ['Dark mode'], freeformValue: 'Also add spell check' }
			});

			expect(result.answers['Features']).toEqual({
				selected: ['Dark mode'],
				freeText: 'Also add spell check',
				skipped: false
			});
		});

		test('handles empty freeformValue (should not count as freeText)', () => {
			const questions: IQuestion[] = [
				{
					header: 'Q1',
					question: 'Question',
					options: [{ label: 'Yes' }, { label: 'No' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': { selectedValue: 'Yes', freeformValue: '' }
			});

			// Empty string freeformValue is falsy, so not treated as freeText
			expect(result.answers['Q1']).toEqual({
				selected: ['Yes'],
				freeText: null,
				skipped: false
			});
		});

		test('handles freeformValue when non-matching selectedValue provided', () => {
			const questions: IQuestion[] = [
				{
					header: 'Color',
					question: 'Pick color',
					options: [{ label: 'Red' }, { label: 'Blue' }]
				}
			];

			// selectedValue doesn't match options, but freeformValue is provided
			const result = tool.testConvertCarouselAnswers(questions, {
				'Color': { selectedValue: 'Purple', freeformValue: 'I want purple with sparkles' }
			});

			// freeformValue takes precedence over selectedValue when selectedValue doesn't match
			expect(result.answers['Color']).toEqual({
				selected: [],
				freeText: 'I want purple with sparkles',
				skipped: false
			});
		});

		test('marks as skipped when selectedValue is null/undefined and no freeformValue', () => {
			const questions: IQuestion[] = [
				{
					header: 'Skipped',
					question: 'Will skip this',
					options: [{ label: 'A' }, { label: 'B' }]
				}
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Skipped': { selectedValue: null }
			});

			expect(result.answers['Skipped']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});
	});

	describe('when answer has unknown format', () => {
		test('treats unknown object format as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'Question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': { unknownProperty: 'value' }
			});

			expect(result.answers['Q1']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});

		test('treats number answer as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'Question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': 42
			});

			expect(result.answers['Q1']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});

		test('treats boolean answer as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'Question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': true
			});

			expect(result.answers['Q1']).toEqual({
				selected: [],
				freeText: null,
				skipped: true
			});
		});

		test('treats null answer as skipped', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'Question?' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': null
			});

			// null is falsy but typeof null === 'object', so it hits the object branch
			// but fails all property checks
			expect(result.answers['Q1'].skipped).toBe(true);
		});
	});

	describe('edge cases', () => {
		test('handles empty questions array', () => {
			const result = tool.testConvertCarouselAnswers([], { 'Extra': 'value' });

			expect(result.answers).toEqual({});
		});

		test('handles questions with special characters in headers', () => {
			const questions: IQuestion[] = [
				{ header: 'What\'s your name?', question: 'Enter name' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'What\'s your name?': 'Bob'
			});

			expect(result.answers['What\'s your name?']).toEqual({
				selected: [],
				freeText: 'Bob',
				skipped: false
			});
		});

		test('handles questions with unicode headers', () => {
			const questions: IQuestion[] = [
				{ header: '你好', question: 'Chinese greeting' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'你好': '世界'
			});

			expect(result.answers['你好']).toEqual({
				selected: [],
				freeText: '世界',
				skipped: false
			});
		});

		test('handles multiple questions with mixed answer formats', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'String answer' },
				{ header: 'Q2', question: 'Object answer', options: [{ label: 'A' }] },
				{ header: 'Q3', question: 'Array answer', multiSelect: true },
				{ header: 'Q4', question: 'Missing answer' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': 'text',
				'Q2': { selectedValue: 'A' },
				'Q3': ['x', 'y']
				// Q4 missing
			});

			expect(result.answers['Q1'].freeText).toBe('text');
			expect(result.answers['Q2'].selected).toEqual(['A']);
			expect(result.answers['Q3'].selected).toEqual(['x', 'y']);
			expect(result.answers['Q4'].skipped).toBe(true);
		});

		test('case-sensitive option matching', () => {
			const questions: IQuestion[] = [
				{
					header: 'CaseSensitive',
					question: 'Pick one',
					options: [{ label: 'Yes' }, { label: 'No' }]
				}
			];

			// 'yes' (lowercase) should NOT match 'Yes'
			const result = tool.testConvertCarouselAnswers(questions, {
				'CaseSensitive': 'yes'
			});

			expect(result.answers['CaseSensitive']).toEqual({
				selected: [],
				freeText: 'yes',
				skipped: false
			});
		});

		test('extra keys in carouselAnswers are ignored', () => {
			const questions: IQuestion[] = [
				{ header: 'Q1', question: 'Only question' }
			];

			const result = tool.testConvertCarouselAnswers(questions, {
				'Q1': 'answer',
				'ExtraKey': 'should be ignored',
				'AnotherExtra': { value: 'also ignored' }
			});

			expect(Object.keys(result.answers)).toEqual(['Q1']);
			expect(result.answers['Q1'].freeText).toBe('answer');
		});
	});
});
