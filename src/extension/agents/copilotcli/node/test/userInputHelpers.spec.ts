/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILogService } from '../../../../../platform/log/common/logService';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { ChatQuestion, ChatQuestionType } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { convertBackgroundQuestionToolResponseToAnswers } from '../userInputHelpers';

function q(id: string, title: string, optionLabels: string[] = []): ChatQuestion {
	return new ChatQuestion(id, ChatQuestionType.SingleSelect, title, {
		options: optionLabels.map(label => ({ id: label, label, value: label })),
	});
}

describe('convertBackgroundQuestionToolResponseToAnswers', () => {
	const disposables = new DisposableStore();
	let logService: ILogService;

	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logService = accessor.get(ILogService);
	});

	afterEach(() => {
		disposables.clear();
	});

	it('marks all questions as skipped when carouselAnswers is undefined', () => {
		const questions = [q('q1', 'Q1'), q('q2', 'Q2')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, undefined, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: null, skipped: true });
		expect(result.answers['q2']).toEqual({ selected: [], freeText: null, skipped: true });
	});

	it('marks a question as skipped when its id is missing from answers', () => {
		const questions = [q('q1', 'Q1')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, {}, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: null, skipped: true });
	});

	it('handles string answer matching a known option as selected', () => {
		const questions = [q('q1', 'Framework', ['React', 'Vue'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: 'React' }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['React'], freeText: null, skipped: false });
	});

	it('handles string answer not matching any option as free text', () => {
		const questions = [q('q1', 'Framework', ['React', 'Vue'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: 'Angular' }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: 'Angular', skipped: false });
	});

	it('handles array answer as multi-select', () => {
		const questions = [q('q1', 'Features')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: ['Auth', 'DB'] }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['Auth', 'DB'], freeText: null, skipped: false });
	});

	it('handles object with selectedValues as multi-select', () => {
		const questions = [q('q1', 'Features')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValues: ['Auth', 'DB'] } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['Auth', 'DB'], freeText: null, skipped: false });
	});

	it('handles object with selectedValues and freeformValue', () => {
		const questions = [q('q1', 'Features')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValues: ['Auth'], freeformValue: 'also caching' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['Auth'], freeText: 'also caching', skipped: false });
	});

	it('handles object with selectedValue matching a known option', () => {
		const questions = [q('q1', 'Framework', ['React', 'Vue'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: 'React' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['React'], freeText: null, skipped: false });
	});

	it('handles object with selectedValue not matching any option as free text', () => {
		const questions = [q('q1', 'Framework', ['React', 'Vue'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: 'Angular' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: 'Angular', skipped: false });
	});

	it('prefers freeformValue over unknown selectedValue for free text', () => {
		const questions = [q('q1', 'Framework', ['React', 'Vue'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: 'Angular', freeformValue: 'Svelte' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: 'Svelte', skipped: false });
	});

	it('handles object with selectedValue as array', () => {
		const questions = [q('q1', 'Features')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: ['Auth', 'DB'] } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['Auth', 'DB'], freeText: null, skipped: false });
	});

	it('handles object with null selectedValue and freeformValue', () => {
		const questions = [q('q1', 'Input')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: null, freeformValue: 'custom text' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: 'custom text', skipped: false });
	});

	it('marks as skipped when selectedValue is null and no freeformValue', () => {
		const questions = [q('q1', 'Input')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: null } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: null, skipped: true });
	});

	it('handles object with only freeformValue (no selection keys)', () => {
		const questions = [q('q1', 'Input')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { freeformValue: 'custom text' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: 'custom text', skipped: false });
	});

	it('handles raw option object with label property', () => {
		const questions = [q('q1', 'Framework')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { label: 'React', description: 'A library' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['React'], freeText: null, skipped: false });
	});

	it('marks unknown object format as skipped', () => {
		const questions = [q('q1', 'Input')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { unknownKey: 123 } }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: null, skipped: true });
	});

	it('marks unknown primitive type as skipped', () => {
		const questions = [q('q1', 'Input')];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: 42 }, logService);
		expect(result.answers['q1']).toEqual({ selected: [], freeText: null, skipped: true });
	});

	it('treats empty string freeformValue as no freeform', () => {
		const questions = [q('q1', 'Framework', ['React'])];
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, { q1: { selectedValue: 'React', freeformValue: '' } }, logService);
		expect(result.answers['q1']).toEqual({ selected: ['React'], freeText: null, skipped: false });
	});

	it('handles multiple questions with mixed answer types', () => {
		const questions = [
			q('q1', 'Framework', ['React', 'Vue']),
			q('q2', 'Features'),
			q('q3', 'Notes'),
		];
		const carouselAnswers = {
			q1: 'React',
			q2: { selectedValues: ['Auth', 'DB'] },
			// q3 missing → skipped
		};
		const result = convertBackgroundQuestionToolResponseToAnswers(questions, carouselAnswers, logService);
		expect(result.answers['q1']).toEqual({ selected: ['React'], freeText: null, skipped: false });
		expect(result.answers['q2']).toEqual({ selected: ['Auth', 'DB'], freeText: null, skipped: false });
		expect(result.answers['q3']).toEqual({ selected: [], freeText: null, skipped: true });
	});
});
