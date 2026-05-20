/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import type { IChatEndpoint } from '../../../networking/common/networking';
import { isVSCModelA, isVSCModelB, isVSCModelC, isVSCModelD, modelSupportsPDFDocuments } from '../../common/chatModelCapabilities';

function fakeModel(family: string) {
	return { family } as unknown as IChatEndpoint;
}

describe('modelSupportsPDFDocuments', () => {
	test('returns true for claude family', () => {
		expect(modelSupportsPDFDocuments(fakeModel('claude-3.5-sonnet'))).toBe(true);
		expect(modelSupportsPDFDocuments(fakeModel('claude-3-opus'))).toBe(true);
		expect(modelSupportsPDFDocuments(fakeModel('claude-4-sonnet'))).toBe(true);
	});

	test('returns true for Anthropic family', () => {
		expect(modelSupportsPDFDocuments(fakeModel('Anthropic'))).toBe(true);
		expect(modelSupportsPDFDocuments(fakeModel('Anthropic-custom'))).toBe(true);
	});

	test('returns false for non-Anthropic families', () => {
		expect(modelSupportsPDFDocuments(fakeModel('gpt-4'))).toBe(false);
		expect(modelSupportsPDFDocuments(fakeModel('gpt-5.1'))).toBe(false);
		expect(modelSupportsPDFDocuments(fakeModel('gemini-2.0-flash'))).toBe(false);
		expect(modelSupportsPDFDocuments(fakeModel('o4-mini'))).toBe(false);
	});
});

describe('VSC model override', () => {
	test('makes the selected family exclusively true', () => {
		const model = { id: 'test-model', model: 'test-model', family: 'test-family' } as unknown as IChatEndpoint;

		expect(isVSCModelA(model, 'C')).toBe(false);
		expect(isVSCModelB(model, 'C')).toBe(false);
		expect(isVSCModelC(model, 'C')).toBe(true);
		expect(isVSCModelD(model, 'C')).toBe(false);
	});

	test('does not force a family when the override is unset', () => {
		const model = { id: 'test-model', model: 'test-model', family: 'test-family' } as unknown as IChatEndpoint;

		expect(isVSCModelA(model, null)).toBe(false);
		expect(isVSCModelB(model, null)).toBe(false);
		expect(isVSCModelC(model, null)).toBe(false);
		expect(isVSCModelD(model, null)).toBe(false);
	});
});
