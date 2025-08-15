/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { DocumentInfo } from '../../common/prompt';
import { ElidableText } from '../elidableText/elidableText';
import { elidableTextForSourceCode } from '../elidableText/fromSourceCode';

function interpretSpec(src: string): [string, string[][]] {
	const linesWithValuesExpected = src.split('\n').map(l => {
		const [text, value] = l.split('//');
		return [text.trimEnd(), parseFloat(value.trim()).toFixed(2)];
	});
	const lines = linesWithValuesExpected.map(([text]) => text);
	return [lines.join('\n'), linesWithValuesExpected];
}

suite('Test elidableTextForSourceCode', function () {
	test('should construct elidable text focussed on the last non-closing leaf', function () {
		const src = `
describe("foo", () => {         // 0.63
    it("should bar", () => {    // 0.50
        expect(1).toBe(1);      // 0.40
    });                         // 0.40
});                             // 0.50
                                // 0.71
describe("baz", () => {         // 0.81
    it("should qux", () => {    // 0.90
        expect(1).toBe(1);      // 1.00
    });                         // 0.88
});                             // 0.79
`.trim();
		const [code, linesWithValuesExpected] = interpretSpec(src);
		const elidableText = elidableTextForSourceCode(code, true, false);
		assert.deepStrictEqual(
			elidableText.lines.map(l => [l.text, l.value.toFixed(2)]),
			linesWithValuesExpected
		);
	});

	test('should construct elidable text focussed on the last non-closing leaf even if there are no closers', function () {
		const src = `
#!/usr/bin/env python              // 0.52
# coding: latin-1                  // 0.56
import time                        // 0.64
def wait(condition, timeout=30):   // 0.73
    t0 = time.time()               // 0.71
    while condition():             // 0.81
        time.sleep(1)              // 0.65
        # Check timeout            // 0.70
        tDelta = time.time()       // 0.79
        if tDelta - t0 >= timeout: // 0.90
            return                 // 1.00
`.trim();
		const [code, linesWithValuesExpected] = interpretSpec(src);
		const elidableText = elidableTextForSourceCode(code, true, false);
		assert.deepStrictEqual(
			elidableText.lines.map(l => [l.text, l.value.toFixed(2)]),
			linesWithValuesExpected
		);
	});

	test('can use DocumentInfo in ElidableText directly; default focusses on beginning and end', function () {
		const src = `
describe("foo", () => {         // 1.00
    it("should bar", () => {    // 0.80
        expect(1).toBe(1);      // 0.64
    });                         // 0.64
});                             // 0.80
                                // 0.88
describe("baz", () => {         // 0.81
    it("should qux", () => {    // 0.90
        expect(1).toBe(1);      // 1.00
    });                         // 0.88
});                             // 0.79
`.trim();
		const [code, linesWithValuesExpected] = interpretSpec(src);
		const documentInfo: DocumentInfo = { uri: 'untitled:Untitled-1', languageId: 'typescript', source: code };
		const elidableText = new ElidableText([documentInfo]);
		assert.deepStrictEqual(
			elidableText.lines.map(l => [l.text, l.value.toFixed(2)]),
			linesWithValuesExpected
		);
	});

	test('should construct elidable text focussed on the last non-closing leaf even if there are no closers via document info', function () {
		const src = `
#!/usr/bin/env python              // 1.00
# coding: latin-1                  // 0.88
import time                        // 0.77
def wait(condition, timeout=30):   // 0.73
    t0 = time.time()               // 0.71
    while condition():             // 0.81
        time.sleep(1)              // 0.65
        # Check timeout            // 0.70
        tDelta = time.time()       // 0.79
        if tDelta - t0 >= timeout: // 0.90
            return                 // 1.00
`.trim();
		const [code, linesWithValuesExpected] = interpretSpec(src);
		const documentInfo: DocumentInfo = { uri: 'untitled:Untitled-1', languageId: 'python', source: code };
		const elidableText = new ElidableText([documentInfo]);
		assert.deepStrictEqual(
			elidableText.lines.map(l => [l.text, l.value.toFixed(2)]),
			linesWithValuesExpected
		);
	});
});
