/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import dedent from 'ts-dedent';

import { getBlockParser } from '../parseBlock';

interface TestCase {
	before: string; // text before the cursor
	body?: string; // body of the block after the cursor
	after?: string; // text after the block
}

/**
 * Trimming modes for IsEmptyBlockStartTestCase below.
 */
enum TrimMode {
	NO_TRIM,
	TRIM_TO_END_OF_LINE,
	TRIM_TO_END_OF_INPUT,
}

/**
 * A convenience class for testing BlockParser.isEmptyBlockStart.
 *
 * To use this, pass a string containing a snippet of source code, and use
 * ðŸŸ¢ for cursor positions at which isEmptyBlockStart should return true,
 * and âŒ for cursor positions where it should return false.  Then call
 * .test() to run the tests.
 *
 * By default, for each cursor position it trims the line from the cursor
 * to the end (i.e., the cursor is always at the end of the line) before
 * executing the test.  Set the trimMode property to change this.
 */
class IsEmptyBlockStartTestCase {
	private readonly text: string;
	private readonly expectTrueOffsets: number[];
	private readonly expectFalseOffsets: number[];
	private trimMode = TrimMode.TRIM_TO_END_OF_INPUT;

	private constructor(
		private readonly languageId: string,
		testCase: string
	) {
		let text = '';
		const expectTrueOffsets: number[] = [];
		const expectFalseOffsets: number[] = [];
		let i = 0;
		// Must use for...of loop to avoid surrogate pair/UTF-16 weirdness
		for (const char of testCase) {
			switch (char) {
				case 'ðŸŸ¢':
					expectTrueOffsets.push(i);
					break;
				case 'âŒ':
					expectFalseOffsets.push(i);
					break;
				default:
					text += char;
					i++;
					break;
			}
		}

		if (expectTrueOffsets.length === 0 && expectFalseOffsets.length === 0) {
			throw new Error('Test case must have at least one cursor');
		}

		this.text = text;
		this.expectTrueOffsets = expectTrueOffsets;
		this.expectFalseOffsets = expectFalseOffsets;
	}

	private trimText(offset: number): string {
		switch (this.trimMode) {
			case TrimMode.NO_TRIM:
				return this.text;
			case TrimMode.TRIM_TO_END_OF_LINE: {
				const nextNewline = this.text.indexOf('\n', offset);
				const fromNewline = nextNewline >= 0 ? this.text.slice(nextNewline) : '';
				return this.text.slice(0, offset) + fromNewline;
			}
			case TrimMode.TRIM_TO_END_OF_INPUT:
				return this.text.slice(0, offset);
		}
	}

	// TODO(eaftan): It would be nice if this could test arbitrary functions.
	async test<T>(): Promise<void> {
		const blockParser = getBlockParser(this.languageId);
		for (const offset of this.expectTrueOffsets) {
			const text = this.trimText(offset);
			const msg = `${this.text.slice(0, offset)}â–ˆ${this.text.slice(offset)}`;
			// common helper to all breaks
			assert.strictEqual(await blockParser.isEmptyBlockStart(text, offset), true, msg);
		}
		for (const offset of this.expectFalseOffsets) {
			const text = this.trimText(offset);
			const msg = `${this.text.slice(0, offset)}â–ˆ${this.text.slice(offset)}`;
			assert.strictEqual(await blockParser.isEmptyBlockStart(text, offset), false, msg);
		}
	}

	setTrimMode(mode: TrimMode): IsEmptyBlockStartTestCase {
		this.trimMode = mode;
		return this;
	}

	static python(testCase: string): IsEmptyBlockStartTestCase {
		return new IsEmptyBlockStartTestCase('python', testCase);
	}

	static javascript(testCase: string): IsEmptyBlockStartTestCase {
		return new IsEmptyBlockStartTestCase('javascript', testCase);
	}

	static typescript(testCase: string): IsEmptyBlockStartTestCase {
		return new IsEmptyBlockStartTestCase('typescript', testCase);
	}

	static ruby(testCase: string): IsEmptyBlockStartTestCase {
		return new IsEmptyBlockStartTestCase('ruby', testCase);
	}

	static go(testCase: string): IsEmptyBlockStartTestCase {
		return new IsEmptyBlockStartTestCase('go', testCase);
	}
}

function runTestCase(languageId: string, testCase: TestCase) {
	const bodyWithAfter = (testCase.body || '') + (testCase.after || '');
	const text = testCase.before + bodyWithAfter;
	const blockParser = getBlockParser(languageId);

	// block is expected to be empty if no body
	const expectedEmpty = !testCase.body;
	// block is expected to be finished after body, if there is a body and an after
	const expectedFinish = testCase.body && testCase.after ? testCase.body.length : undefined;

	// cursor position is after the before text
	const offset = testCase.before.length;
	// print the text with a cursor indicator on failure
	const prettyPrint = ('\n' + testCase.before + 'â–ˆ' + bodyWithAfter).split('\n').join('\n\t| ');

	test(`empty block start:${expectedEmpty}`, async function () {
		const isEmpty = await blockParser.isEmptyBlockStart(text, offset);
		// test isEmpty matched expectation
		assert.strictEqual(isEmpty, expectedEmpty, prettyPrint);
	});

	test(`block finish:${expectedFinish}`, async function () {
		const isFinished = await blockParser.isBlockBodyFinished(testCase.before, bodyWithAfter, offset);
		// test isFinished matched expectation
		assert.strictEqual(isFinished, expectedFinish, prettyPrint);
	});
}

function runTestCases(languageId: string, testCases: TestCase[]) {
	for (const testCase of testCases) {
		runTestCase(languageId, testCase);
	}
}

function getNodeStartTestCase(testCase: string): [string, number[], number[], number] {
	let text = '';
	let i = 0;
	let expectedResult = 0;
	const positiveTests: number[] = [];
	const rejectedTests: number[] = [];

	// Must use for...of loop to avoid surrogate pair/UTF-16 weirdness
	for (const char of testCase) {
		switch (char) {
			//Test cases that should pass the test
			case 'ðŸŸ¢':
				positiveTests.push(i);
				break;
			//Test cases that should fail the test
			case 'âŒ':
				rejectedTests.push(i);
				break;
			//Location used for the assertions (begining of the node we want to detect)
			case 'ðŸ”µ':
				expectedResult = i;
				break;
			default:
				text += char;
				i++;
				break;
		}
	}

	return [text, positiveTests, rejectedTests, expectedResult];
}

/**
 * Helper function for testing `getNodeStart`
 *
 * To use this, pass a language ID and a string containing a snippet of source code, and use
 * ðŸ”µ for a location that's used for assertion ( begining of the node we want to detect)
 * ðŸŸ¢ for cursor positions at which `getNodeStart` should return the position ðŸ”µ,
 * and âŒ for cursor positions where it shouldn't.
 */
async function testGetNodeStart(languageId: string, testCase: string) {
	const blockParser = getBlockParser(languageId);
	const [code, positiveOffsets, rejectedOffsets, expected_result] = getNodeStartTestCase(testCase);
	for (const offset of positiveOffsets) {
		const start = await blockParser.getNodeStart(code, offset);
		assert.strictEqual(start, expected_result, 'Should get beginning of the scope');
	}
	for (const offset of rejectedOffsets) {
		const start = await blockParser.getNodeStart(code, offset);
		assert.notStrictEqual(
			start,
			expected_result,
			`Should not get begining of the scope - tested offset: ${offset}`
		);
	}
}

suite('parseBlock Tests', function () {
	suite('getBlockParser tests', function () {
		test('Supported and unsupported languages', function () {
			const supportedLanguages = ['python', 'javascript', 'typescript', 'go', 'ruby'];
			for (const language of supportedLanguages) {
				assert.ok(getBlockParser(language));
			}

			// Taken from https://insights.stackoverflow.com/survey/2020#most-popular-technologies and
			// https://code.visualstudio.com/docs/languages/identifiers
			const unsupportedLanguages = ['sql', 'java', 'shellscript', 'php', 'cpp', 'c', 'kotlin'];
			for (const language of unsupportedLanguages) {
				assert.throws(() => getBlockParser(language));
			}
		});
	});

	suite('Python isEmptyBlockStart tests', function () {
		test('Invalid positions', async function () {
			const text = dedent`
				def foo():
					pass
			`;
			const blockParser = getBlockParser('python');
			await assert.rejects(blockParser.isEmptyBlockStart(text, text.length + 1));
		});

		test('simple examples', async function () {
			const testCases: IsEmptyBlockStartTestCase[] = [
				IsEmptyBlockStartTestCase.python(dedent`
					âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					âŒeâŒlâŒiâŒfðŸŸ¢ ðŸŸ¢bðŸŸ¢aðŸŸ¢rðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					eâŒlâŒsâŒeðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒssâŒ
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					eâŒlâŒsâŒeðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒtâŒrâŒyðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					âŒeâŒxâŒcâŒeâŒpâŒtðŸŸ¢ ðŸŸ¢EðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒtâŒrâŒyðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢ ðŸŸ¢bðŸŸ¢aðŸŸ¢rðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒwâŒhâŒiâŒlâŒeðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒwâŒiâŒtâŒhðŸŸ¢ ðŸŸ¢oðŸŸ¢pðŸŸ¢eðŸŸ¢nðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢aðŸŸ¢sðŸŸ¢ ðŸŸ¢fðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢FðŸŸ¢oðŸŸ¢oðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pâŒaâŒsâŒsâŒ
					`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('func_decl', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python('âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢:ðŸŸ¢'),
				IsEmptyBlockStartTestCase.python(dedent`
					âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢:ðŸŸ¢
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢
					ðŸŸ¢
					`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('multiline_func_decl', async function () {
			const testCase = IsEmptyBlockStartTestCase.python(dedent`
					 âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢aðŸŸ¢,ðŸŸ¢
							 ðŸŸ¢bðŸŸ¢,ðŸŸ¢
							 ðŸŸ¢cðŸŸ¢)ðŸŸ¢:ðŸŸ¢
						 ðŸŸ¢
					 `);

			await testCase.test();
		});

		test('func_decl_in_middle_of_file', async function () {
			// Trailing whitespace is intentional, do not remove!
			const testCase = IsEmptyBlockStartTestCase.python(
				dedent`
					"""This is a module."""
					import foo

					âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢uðŸŸ¢nðŸŸ¢cðŸŸ¢1ðŸŸ¢(ðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢ ðŸŸ¢

					print("Running at toplevel")
				`
			).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE);
			// break 1
			await testCase.test();
		});

		test('func_decl_with_type_hints', async function () {
			const testCase = IsEmptyBlockStartTestCase.python(
				'âŒdâŒeâŒfðŸŸ¢ ðŸŸ¢sðŸŸ¢uðŸŸ¢mðŸŸ¢(ðŸŸ¢aðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢,ðŸŸ¢ ðŸŸ¢bðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢ ðŸŸ¢-ðŸŸ¢>ðŸŸ¢ ðŸŸ¢IðŸŸ¢nðŸŸ¢tðŸŸ¢:ðŸŸ¢'
			);
			await testCase.test();
		});

		test('block not empty', async function () {
			const testCase = IsEmptyBlockStartTestCase.python(
				dedent`
				def func1():
					âŒ
					passâŒ
					âŒ
			`
			).setTrimMode(TrimMode.NO_TRIM);
			await testCase.test();
		});

		test('docstring', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python(dedent`
					def my_func():
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢"ðŸŸ¢"ðŸŸ¢"ðŸŸ¢TðŸŸ¢hðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢ ðŸŸ¢dðŸŸ¢oðŸŸ¢cðŸŸ¢sðŸŸ¢tðŸŸ¢rðŸŸ¢iðŸŸ¢nðŸŸ¢gðŸŸ¢.ðŸŸ¢"ðŸŸ¢"ðŸŸ¢"ðŸŸ¢
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					def my_func():
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢'ðŸŸ¢'ðŸŸ¢'ðŸŸ¢TðŸŸ¢hðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢ ðŸŸ¢dðŸŸ¢oðŸŸ¢cðŸŸ¢sðŸŸ¢tðŸŸ¢rðŸŸ¢iðŸŸ¢nðŸŸ¢gðŸŸ¢.ðŸŸ¢'ðŸŸ¢'ðŸŸ¢'ðŸŸ¢
				`),
			];
			for (const testCase of testCases) {
				// break 2
				await testCase.test();
			}
		});

		test('multiline docstring', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python(dedent`
					def my_func():
						"""ðŸŸ¢TðŸŸ¢hðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢ ðŸŸ¢mðŸŸ¢uðŸŸ¢lðŸŸ¢tðŸŸ¢iðŸŸ¢lðŸŸ¢iðŸŸ¢nðŸŸ¢eðŸŸ¢ ðŸŸ¢dðŸŸ¢oðŸŸ¢cðŸŸ¢sðŸŸ¢tðŸŸ¢rðŸŸ¢iðŸŸ¢nðŸŸ¢gðŸŸ¢.ðŸŸ¢
						ðŸŸ¢
						ðŸŸ¢HðŸŸ¢eðŸŸ¢rðŸŸ¢eðŸŸ¢'ðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢nðŸŸ¢oðŸŸ¢tðŸŸ¢hðŸŸ¢eðŸŸ¢rðŸŸ¢ ðŸŸ¢lðŸŸ¢iðŸŸ¢nðŸŸ¢eðŸŸ¢.ðŸŸ¢"ðŸŸ¢"ðŸŸ¢"ðŸŸ¢
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					def my_func():
						'''ðŸŸ¢TðŸŸ¢hðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢iðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢ ðŸŸ¢mðŸŸ¢uðŸŸ¢lðŸŸ¢tðŸŸ¢iðŸŸ¢lðŸŸ¢iðŸŸ¢nðŸŸ¢eðŸŸ¢ ðŸŸ¢dðŸŸ¢oðŸŸ¢cðŸŸ¢sðŸŸ¢tðŸŸ¢rðŸŸ¢iðŸŸ¢nðŸŸ¢gðŸŸ¢.ðŸŸ¢
						ðŸŸ¢
						ðŸŸ¢HðŸŸ¢eðŸŸ¢rðŸŸ¢eðŸŸ¢'ðŸŸ¢sðŸŸ¢ ðŸŸ¢aðŸŸ¢nðŸŸ¢oðŸŸ¢tðŸŸ¢hðŸŸ¢eðŸŸ¢rðŸŸ¢ ðŸŸ¢lðŸŸ¢iðŸŸ¢nðŸŸ¢eðŸŸ¢.ðŸŸ¢'ðŸŸ¢'ðŸŸ¢'ðŸŸ¢
				`),
			];

			for (const testCase of testCases) {
				// break 2
				await testCase.test();
			}
		});

		// TODO(eaftan): Ideally this test should pass, but the parse tree for unclosed docstrings
		// is very odd, and I can't think of a way to distinuish between a broken parse tree without
		// a block body and one with a block body.  In practice in the extension, the check for
		// isBlockBodyFinished prevents a multline suggestion from being given in this situation,
		// because the block isn't finished until after the pass statement.
		test.skip('docstring with body', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python(
					dedent`
					def my_func():âŒ
						"âŒ"âŒ"âŒTâŒhâŒiâŒsâŒ âŒiâŒsâŒ âŒaâŒ âŒdâŒoâŒcâŒsâŒtâŒrâŒiâŒnâŒgâŒ.âŒ"âŒ"âŒ"âŒ
						pass
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.python(
					dedent`
					def my_func():âŒ
						"âŒ"âŒ"âŒTâŒhâŒiâŒsâŒ âŒiâŒsâŒ âŒaâŒ âŒdâŒoâŒcâŒsâŒtâŒrâŒiâŒnâŒgâŒ.âŒ

						âŒHâŒeâŒrâŒeâŒ'âŒsâŒ âŒaâŒnâŒoâŒtâŒhâŒeâŒrâŒ âŒlâŒiâŒnâŒeâŒ.âŒ"âŒ"âŒ"âŒ
						pass
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('Not EOL', async function () {
			const testCase = IsEmptyBlockStartTestCase.python('def my_âŒfunc():').setTrimMode(TrimMode.NO_TRIM);
			await testCase.test();
		});

		test('if-elif-else', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢:ðŸŸ¢
						ðŸŸ¢passâŒ
					âŒeâŒlâŒiâŒfðŸŸ¢ ðŸŸ¢bðŸŸ¢aðŸŸ¢rðŸŸ¢:ðŸŸ¢
						ðŸŸ¢passâŒ
					âŒeâŒlâŒsâŒeðŸŸ¢:
						ðŸŸ¢passâŒ
					`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		// regression tests for #466
		test('block in error state', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.python(dedent`
					def create_tables(conn):ðŸŸ¢
						"""Create the tables students, courses and enrolledðŸŸ¢"""ðŸŸ¢
						conn = sqlite3.connect(results_db_path)âŒ
						c = conn.cursor()âŒ
						c.execute('''CREATE TABLE students (âŒ
					âŒ
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					if True:ðŸŸ¢
						conn = sqlite3.connect(results_db_path)âŒ
						c = conn.cursor()âŒ
						c.execute('''CREATE TABLE students (âŒ
					âŒ
				`),
				IsEmptyBlockStartTestCase.python(dedent`
					try:ðŸŸ¢
						conn = sqlite3.connect(results_db_path)âŒ
						c = conn.cursor()âŒ
						c.execute('''CREATE TABLE students (âŒ
					âŒ
				`),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});
	});

	suite('JavaScript isEmptyBlockStart tests', function () {
		test('arrow_function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒ(âŒaâŒ)âŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒaâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				// Note: We don't try to give a multline-suggestion immediately after "async".
				// "async" is a keyword but not a reserved one, so it may be used as an
				// identifier.  Therefore when you have a partially written async function declaration,
				// tree-sitter often parses it as a completed node of some other type (e.g. "async (a)"
				// is parsed as a call of a function named "async" with arguments "a"). We'd have to do
				// very hacky things to support this.
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒ(âŒaâŒ)âŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒaâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('try_statement, catch_clause, finally_clause', async function () {
			const testCases: IsEmptyBlockStartTestCase[] = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒcâŒaâŒtâŒcâŒhðŸŸ¢ ðŸŸ¢(ðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒcâŒaâŒtâŒcâŒhðŸŸ¢ ðŸŸ¢(ðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('do_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒdâŒoðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ âŒwâŒhâŒiâŒlâŒeâŒ âŒ(âŒtâŒrâŒuâŒeâŒ)âŒ;âŒ
			`);

			await testCase.test();
		});

		// tree-sitter's "for_in_statement" includes both for...in and for...of.
		test('for_in_statement', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢vðŸŸ¢aðŸŸ¢rðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢ ðŸŸ¢oðŸŸ¢bðŸŸ¢jðŸŸ¢eðŸŸ¢cðŸŸ¢tðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢vðŸŸ¢aðŸŸ¢rðŸŸ¢ ðŸŸ¢oðŸŸ¢fðŸŸ¢ ðŸŸ¢oðŸŸ¢bðŸŸ¢jðŸŸ¢eðŸŸ¢cðŸŸ¢tðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('for_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢iðŸŸ¢ ðŸŸ¢=ðŸŸ¢ ðŸŸ¢0ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢ ðŸŸ¢<ðŸŸ¢ ðŸŸ¢5ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢+ðŸŸ¢+ðŸŸ¢)ðŸŸ¢ {ðŸŸ¢
					;âŒ
				âŒ}âŒ
			`);

			await testCase.test();
		});

		test('if_statement', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒeâŒlâŒsâŒeðŸŸ¢ ðŸŸ¢iâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢bðŸŸ¢aðŸŸ¢rðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒeâŒlâŒsâŒeðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('method_definition', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				class Foo {
					ðŸŸ¢bâŒaâŒrâŒ(âŒ)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				}
			`);

			await testCase.test();
		});

		test('switch_case, switch_default', async function () {
			// We don't give multline suggestions for switch_case and switch_default
			// because they are almost never blocks.
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				switch (foo) {
					âŒcâŒaâŒsâŒeâŒ âŒbâŒaâŒrâŒ:âŒ
						âŒbâŒrâŒeâŒaâŒkâŒ;âŒ
					âŒdâŒeâŒfâŒaâŒuâŒlâŒtâŒ:âŒ
						âŒbâŒrâŒeâŒaâŒkâŒ;âŒ
				}
			`);

			await testCase.test();
		});

		test('while_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒwâŒhâŒiâŒlâŒeðŸŸ¢ ðŸŸ¢(ðŸŸ¢tðŸŸ¢rðŸŸ¢uðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		test('with_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒwâŒiâŒtâŒhðŸŸ¢ ðŸŸ¢(ðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		// For the remaining node types (e.g. "function", "generator_function"), tree-sitter
		// uses different node types to distinguish between ones used as declarations/statements
		// and ones used as expressions.  For example, "function_declaration" is a function declaration
		// used as a declaration/statement, and "function" is the same thing used as an expression.

		test('function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('function_declaration', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢
					ðŸŸ¢}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('generator_function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('generator_function_declaration', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.javascript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('class', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒlâŒeâŒtâŒ âŒcâŒ âŒ=âŒ âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢CðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		test('class_declaration', async function () {
			const testCase = IsEmptyBlockStartTestCase.javascript(dedent`
				âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢CðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		// In JS/TS, when the code doesn't parse, it can be ambiguous whether
		// two functions are siblings or one is a local function under the other
		// (meaning the block is not empty and we should return false).
		//
		// TODO(eaftan): fix this and enable the test
		test.skip('local or siblings', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢
					function bar() {}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnâŒ âŒfâŒoâŒoâŒ(âŒ)âŒ âŒ{âŒ
						âŒ
						function bar() {}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢
					let a = 10;
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnâŒ âŒfâŒoâŒoâŒ(âŒ)âŒ âŒ{âŒ
						âŒ
						let a = 10;
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('regression test for #526', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					() => doIt(âŒ
						âŒfâŒoâŒoâŒ.âŒfâŒoâŒoâŒ,âŒ
						âŒbâŒaâŒrâŒ.âŒbâŒaâŒzâŒ,âŒ
						âŒbâŒaâŒzâŒ.âŒbâŒaâŒzâŒ
					);
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.javascript(
					dedent`
					() => doIt(âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ
					);
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.javascript(dedent`
					() => doIt(âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ
					);
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});
	});

	suite('TypeScript isEmptyBlockStart tests', function () {
		// "declare" is a contextual keyword, so we don't try to give a multiline
		// suggestion until after "global," when it transitions from an identifer to a keyword.
		test('ambient_declaration', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒdâŒeâŒcâŒlâŒaâŒrâŒeâŒ âŒgâŒlâŒoâŒbâŒaâŒlðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);

			await testCase.test();
		});

		// "namespace" is a contextual keyword, so we don't try to give a multiline
		// suggestion until the open quote, when it transitions from an identifer to a keyword.
		test('internal_module', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒnâŒaâŒmâŒeâŒsâŒpâŒaâŒcâŒeâŒ âŒ"ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢"ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);

			await testCase.test();
		});

		// "module" is a contextual keyword, so we don't try to give a multiline
		// suggestion until the open quote, when it transitions from an identifer to a keyword.
		test('module', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒmâŒoâŒdâŒuâŒlâŒeâŒ âŒ"ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢"ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					;âŒ
				âŒ}âŒ
			`);

			await testCase.test();
		});

		test('arrow_function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒ(âŒaâŒ)âŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒ(âŒaâŒ:âŒ âŒsâŒtâŒrâŒiâŒnâŒgâŒ)âŒ:âŒ âŒvâŒoâŒiâŒdâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒ(âŒaâŒ)âŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒ(âŒaâŒ:âŒ âŒsâŒtâŒrâŒiâŒnâŒgâŒ)âŒ:âŒ âŒvâŒoâŒiâŒdâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒaâŒ âŒ=âŒ>ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		// TODO(eaftan): a catch variable may have a type annotation of "any" or "unknown",
		// but the version of tree-sitter we're using doesn't support it yet.  Add
		// a test case when it's ready.  See https://github.com/tree-sitter/tree-sitter-typescript/commit/cad2b85fd1136a5e12d3e089030b81d9fe4a0a08
		test('try_statement, catch_clause, finally_clause', async function () {
			const testCases: IsEmptyBlockStartTestCase[] = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒcâŒaâŒtâŒcâŒhðŸŸ¢ ðŸŸ¢(ðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒtâŒrâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒcâŒaâŒtâŒcâŒhðŸŸ¢ ðŸŸ¢(ðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒfâŒiâŒnâŒaâŒlâŒlâŒyðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('do_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒdâŒoðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ âŒwâŒhâŒiâŒlâŒeâŒ âŒ(âŒtâŒrâŒuâŒeâŒ)âŒ;âŒ
			`);

			await testCase.test();
		});

		// tree-sitter's "for_in_statement" includes both for...in and for...of.
		test('for_in_statement', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢vðŸŸ¢aðŸŸ¢rðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢ ðŸŸ¢oðŸŸ¢bðŸŸ¢jðŸŸ¢eðŸŸ¢cðŸŸ¢tðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢vðŸŸ¢aðŸŸ¢rðŸŸ¢ ðŸŸ¢oðŸŸ¢fðŸŸ¢ ðŸŸ¢oðŸŸ¢bðŸŸ¢jðŸŸ¢eðŸŸ¢cðŸŸ¢tðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('for_statement', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢iðŸŸ¢ ðŸŸ¢=ðŸŸ¢ ðŸŸ¢0ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢ ðŸŸ¢<ðŸŸ¢ ðŸŸ¢5ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢+ðŸŸ¢+ðŸŸ¢)ðŸŸ¢ {ðŸŸ¢
						;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒoâŒrðŸŸ¢ ðŸŸ¢(ðŸŸ¢lðŸŸ¢eðŸŸ¢tðŸŸ¢ ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢ ðŸŸ¢=ðŸŸ¢ ðŸŸ¢0ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢ ðŸŸ¢<ðŸŸ¢ ðŸŸ¢5ðŸŸ¢;ðŸŸ¢ ðŸŸ¢iðŸŸ¢+ðŸŸ¢+ðŸŸ¢)ðŸŸ¢ {ðŸŸ¢
						;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('if_statement', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒeâŒlâŒsâŒeðŸŸ¢ ðŸŸ¢iâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢bðŸŸ¢aðŸŸ¢rðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒiâŒfðŸŸ¢ ðŸŸ¢(ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ âŒeâŒlâŒsâŒeðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('method_definition', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					class Foo {
						ðŸŸ¢bâŒaâŒrâŒ(âŒ)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
							ðŸŸ¢;âŒ
						âŒ}âŒ
					}
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					class Foo {
						ðŸŸ¢bâŒaâŒrâŒ(âŒiâŒ:âŒ âŒiâŒnâŒtâŒ)ðŸŸ¢:âŒ âŒvðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
							ðŸŸ¢;âŒ
						âŒ}âŒ
					}
				`),
				// TODO(eaftan): fix sibling function issue and enable this test
				// IsEmptyBlockStartTestCase.typescript(dedent`
				//     class Foo {
				//         fâŒoâŒoâŒ(âŒ)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
				//         ðŸŸ¢}âŒ

				//         âŒbâŒaâŒrâŒ(âŒ)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
				//         ðŸŸ¢}âŒ
				//     }
				// `).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('method_signature', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					class Foo {
						ðŸŸ¢bâŒaâŒrâŒ(âŒ)ðŸŸ¢;âŒ
					}
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					class Foo {
						ðŸŸ¢bâŒaâŒrâŒ(âŒiâŒ:âŒ âŒiâŒnâŒtâŒ)ðŸŸ¢:âŒ âŒvðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢;âŒ
					}
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('switch_case, switch_default', async function () {
			// We don't give multline suggestions for switch_case and switch_default
			// because they are almost never blocks.
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				switch (foo) {
					âŒcâŒaâŒsâŒeâŒ âŒbâŒaâŒrâŒ:âŒ
						âŒbâŒrâŒeâŒaâŒkâŒ;âŒ
					âŒdâŒeâŒfâŒaâŒuâŒlâŒtâŒ:âŒ
						âŒbâŒrâŒeâŒaâŒkâŒ;âŒ
				}
			`);

			await testCase.test();
		});

		test('while_statement', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒwâŒhâŒiâŒlâŒeðŸŸ¢ ðŸŸ¢(ðŸŸ¢tðŸŸ¢rðŸŸ¢uðŸŸ¢eðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		// For the remaining node types (e.g. "function", "generator_function"), tree-sitter
		// uses different node types to distinguish between ones used as declarations/statements
		// and ones used as expressions.  For example, "function_declaration" is a function declaration
		// used as a declaration/statement, and "function" is the same thing used as an expression.

		test('function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒfâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢(iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('function_declaration', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢
					ðŸŸ¢}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢ ðŸŸ¢
					ðŸŸ¢}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(âŒxâŒ âŒ:âŒ âŒnâŒuâŒmâŒbâŒeâŒrâŒ,âŒ
						ðŸŸ¢yðŸŸ¢ ðŸŸ¢:ðŸŸ¢ ðŸŸ¢nðŸŸ¢uðŸŸ¢mðŸŸ¢bðŸŸ¢eðŸŸ¢rðŸŸ¢)ðŸŸ¢ ðŸŸ¢:ðŸŸ¢ ðŸŸ¢nðŸŸ¢uðŸŸ¢mðŸŸ¢bðŸŸ¢eðŸŸ¢rðŸŸ¢;âŒ
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢
						ðŸŸ¢
					let x = 0;
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					function f(âŒ
					/** first parameter */
					x: number,
					/** second parameter */
					y: number);
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					function getPosition() : {âŒ
						start: number,âŒ
						end: numberâŒ
					};
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('generator_function', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒlâŒeâŒtâŒ âŒgâŒ âŒ=âŒ âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('generator_function_declaration', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
				IsEmptyBlockStartTestCase.typescript(dedent`
					âŒaâŒsâŒyâŒnâŒcâŒ âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢*ðŸŸ¢ ðŸŸ¢gðŸŸ¢eðŸŸ¢nðŸŸ¢eðŸŸ¢rðŸŸ¢aðŸŸ¢tðŸŸ¢oðŸŸ¢rðŸŸ¢(ðŸŸ¢iðŸŸ¢:ðŸŸ¢ ðŸŸ¢iðŸŸ¢nðŸŸ¢tðŸŸ¢)ðŸŸ¢:ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢;âŒ
					âŒ}âŒ
				`),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('class', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒlâŒeâŒtâŒ âŒcâŒ âŒ=âŒ âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢CðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		test('class_declaration', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢CðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		test('abstract_class_declaration', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
			âŒaâŒbâŒsâŒtâŒrâŒaâŒcâŒtâŒ âŒcâŒlâŒaâŒsâŒsðŸŸ¢ ðŸŸ¢CðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢;âŒ
				âŒ}âŒ
			`);
			await testCase.test();
		});

		// In JS/TS, when the code doesn't parse, it can be ambiguous whether
		// two functions are siblings or one is a local function under the other
		// (meaning the block is not empty and we should return false).
		//
		// TODO(eaftan): fix this and enable the test
		test.skip('local or siblings', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
						ðŸŸ¢
					function bar() {}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnâŒ âŒfâŒoâŒoâŒ(âŒ)âŒ âŒ{âŒ
						âŒ
						function bar() {}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢oðŸŸ¢oðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢
					let a = 10;
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnâŒ âŒfâŒoâŒoâŒ(âŒ)âŒ âŒ{âŒ
						âŒ
						let a = 10;
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('regression test for #526', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					() => doIt(âŒ
						âŒfâŒoâŒoâŒ.âŒfâŒoâŒoâŒ,âŒ
						âŒbâŒaâŒrâŒ.âŒbâŒaâŒzâŒ,âŒ
						âŒbâŒaâŒzâŒ.âŒbâŒaâŒzâŒ
					);
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(
					dedent`
					() => doIt(âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ
					);
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.typescript(dedent`
					() => doIt(âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ,âŒ
						âŒ'âŒaâŒ'âŒ
					);
				`),
			];

			for (const testCase of testCases) {
				await testCase.test();
			}
		});

		test('function type', async function () {
			const testCase = IsEmptyBlockStartTestCase.typescript(dedent`
				âŒfâŒuâŒnâŒcâŒtâŒiâŒoâŒnðŸŸ¢ ðŸŸ¢fðŸŸ¢(ðŸŸ¢cðŸŸ¢bðŸŸ¢:ðŸŸ¢ ðŸŸ¢(ðŸŸ¢)ðŸŸ¢ ðŸŸ¢=ðŸŸ¢>ðŸŸ¢ ðŸŸ¢vðŸŸ¢oðŸŸ¢iðŸŸ¢dðŸŸ¢)ðŸŸ¢ ðŸŸ¢{ðŸŸ¢
					ðŸŸ¢câŒbâŒ(âŒ)âŒ;âŒ
				âŒ}âŒ
			`);

			await testCase.test();
		});
	});

	suite('Ruby isEmptyBlockStart tests', function () {
		test('simple examples', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.ruby(dedent`
					def ðŸŸ¢greetðŸŸ¢
						ðŸŸ¢puts "Hello"âŒ
						âŒputs "Bye"âŒ
					end
				`),
				IsEmptyBlockStartTestCase.ruby(
					dedent`
					def ðŸŸ¢greetâŒ
						ðŸŸ¢puts "Hello"âŒ
					end
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.ruby(
					dedent`
					def ðŸŸ¢greetâŒ
						âŒputs "Hello"âŒ
						âŒputs "Bye"âŒ
					end
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});
	});

	suite('Go isEmptyBlockStart tests', function () {
		test('simple examples', async function () {
			const testCases = [
				IsEmptyBlockStartTestCase.go(dedent`
					func ðŸŸ¢greetðŸŸ¢()ðŸŸ¢ {ðŸŸ¢
						ðŸŸ¢fmt.Println("Hello")âŒ
						âŒfmt.Println("Bye")âŒ
					}
				`),
				IsEmptyBlockStartTestCase.go(
					dedent`
					func ðŸŸ¢greetðŸŸ¢()ðŸŸ¢ {âŒ
						ðŸŸ¢fmt.Println("Hello")âŒ
					}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
				IsEmptyBlockStartTestCase.go(
					dedent`
					func ðŸŸ¢greetðŸŸ¢()ðŸŸ¢ {âŒ
						âŒfmt.Println("Hello")âŒ
						âŒfmt.Println("Bye")âŒ
					}
				`
				).setTrimMode(TrimMode.TRIM_TO_END_OF_LINE),
			];
			for (const testCase of testCases) {
				await testCase.test();
			}
		});
	});

	suite('python block body tests', function () {
		const pythonBlockTests: TestCase[] = [
			{ before: 'def foo():', body: '\n\tpass' },
			{ before: 'def foo', body: '():\n\tpass', after: '\npass' },
			{ before: 'def foo():', body: '\n\tpass', after: '\npass' },
			{ before: 'def foo():', body: '\n\tpass', after: '\n\t\npass' },
			{ before: 'def foo(arg1', body: '):\n\tpass', after: '\npass' },
			{ before: 'def foo(arg1', body: '\n\t\t):\n\tpass', after: '\npass' },
			{ before: 'def foo(arg1,', body: ' arg2):\n\tpass', after: '\npass' },
			{ before: 'def foo', body: '():\n\tpass', after: '\n\npass' },
			{ before: 'def foo' },
			{ before: 'def foo', body: '():\n\t1+1\n\t# comment' },
			{ before: 'def foo', body: '():\n\t1+1\n\t# comment1', after: '\n# comment2' },
			{ before: 'def foo', body: '():\n\t# comment' },
			{ before: 'def foo', body: '():\n\t1+1 # comment1', after: '\n# comment2' },
			{ before: 'def foo', body: '():\n\t# comment1\n\t1+1', after: '\n# comment2' },
			{ before: 'def foo', body: '():\n\t# comment1\n\t# comment2' },
			{ before: 'def foo', body: '():\n\t# comment1\n\t# comment2', after: '\n# comment3' },
			{ before: 'def foo', body: '(): #comment1' },
			{ before: 'def foo', body: '():#comment1' },
			{ before: 'try:', after: '\nexcept: pass' },
			{ before: 'try:', body: '\n\t1+1', after: '\nexcept: pass' },
			{ before: 'try:\n\tpass\nfinally:\n\tif 1:', body: '\n\t\tpass', after: '\npass' },
			{ before: 'try:\n\tpass\nfinally:\n\tif 1:', after: '\npass' },
			{ before: 'if 1:\n\tpass\nelse:\n\tif 2:', after: '\npass' },
			{ before: 'if 1:\n\tpass\nelse:\n\tif 2:', after: '\n\tpass' },
			{ before: 'if 1:\n\tpass\nelse:\n\tif 2:', after: '\n\n\tpass' },
			{
				before: 'class C:\n\t"""docstring"""\n',
				body: '\tdef foo():\n\t\tpass\n\tdef bar():\n\t\tpass',
				after: '\npass',
			},
			{ before: 'class C:\n', body: '\tdef foo():\n\tpass\n\tdef bar():\n\t\tpass', after: '\npass' },
			{
				before: 'for ',
				body: " record in records:\n\taccount_id = record'actor_id']\n\trecord['account_tier'] = account_tiers[account_id]",
				after: '\n\nprint(records)',
			},
		];
		runTestCases('python', pythonBlockTests);
	});

	suite('Python getBlockStart tests', function () {
		test('class_definition', async function () {
			const code = dedent`
				ðŸ”µclass MyClass:ðŸŸ¢
					ðŸŸ¢"""A simpleðŸŸ¢ example class"""ðŸŸ¢
					ðŸŸ¢i = 12ðŸŸ¢345ðŸŸ¢
					ðŸŸ¢
					âŒdefâŒ f(self):âŒ
						âŒreturnâŒ 'helloâŒ world'âŒ

				`;

			await testGetNodeStart('python', code);
		});

		test('elif_clause', async function () {
			const code = dedent`
				def âŒsample():âŒ
					âŒif 1âŒ:
						âŒpassâŒ
					ðŸ”µelifðŸŸ¢ 2ðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
					âŒelse:âŒ
						âŒpassâŒ
				`;

			await testGetNodeStart('python', code);
		});

		test('else_clause', async function () {
			const code = dedent`
				âŒdef âŒsample():âŒ
					âŒif 1:âŒ
						âŒpassâŒ
					âŒelif 2:âŒ
						âŒpassâŒ
					ðŸ”µelseðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});

		test('except_clause', async function () {
			const code = dedent`
				âŒdefâŒ âŒsampleâŒ()âŒ:âŒ
					âŒtry:âŒ
						âŒpassâŒ
					ðŸ”µexceptðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});

		test('finally_clause', async function () {
			const code = dedent`
				âŒdefâŒ saâŒmpleâŒ()âŒ:âŒ
					âŒtry:
						âŒpassâŒ
					ðŸ”µfinallyðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});

		test('for_statement', async function () {
			const code = dedent`
				âŒdefâŒ âŒsample(âŒ):âŒ
					âŒfruitsâŒ = âŒ["apple", "banana", "cherry"]âŒ
					ðŸ”µforðŸŸ¢ x inðŸŸ¢ frðŸŸ¢uitsðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});

		test('function_definition', async function () {
			const code = dedent`
				ðŸ”µdefðŸŸ¢ samðŸŸ¢pleðŸŸ¢(ðŸŸ¢)ðŸŸ¢:
					ðŸŸ¢"""Sample ðŸŸ¢comment"""ðŸŸ¢
					ðŸŸ¢fruitsðŸŸ¢ = ðŸŸ¢["apple", ðŸŸ¢"banana",ðŸŸ¢ "cherry"]ðŸŸ¢
					âŒforâŒ xâŒ inâŒ fruitsâŒ:âŒ
						âŒpâŒaâŒsâŒsâŒ
				`;

			await testGetNodeStart('python', code);
		});

		test('if_statement', async function () {
			const code = dedent`
				âŒdef âŒsampleâŒ(âŒ)âŒ:âŒ
					ðŸ”µif ðŸŸ¢1ðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
					âŒelifâŒ 2:âŒ
						âŒpass
					âŒelse:âŒ
						âŒpass
				`;

			await testGetNodeStart('python', code);
		});

		test('try_statement', async function () {
			const code = dedent`
				âŒdefâŒ âŒsampleâŒ(âŒ)âŒ:âŒ
					ðŸ”µtryðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
					âŒfinâŒallâŒy:âŒ
						âŒpassâŒ
				`;

			await testGetNodeStart('python', code);
		});

		test('while_statement', async function () {
			const code = dedent`
				âŒdefâŒ saâŒmple(âŒ)âŒ:âŒ
					ðŸ”µwhileðŸŸ¢ ðŸŸ¢TrðŸŸ¢ueðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});

		test('with_statement', async function () {
			const code = dedent`
				âŒdefâŒ âŒsaâŒmpleâŒ(âŒ)âŒ:âŒ
					ðŸ”µwithðŸŸ¢ ðŸŸ¢openðŸŸ¢(ðŸŸ¢'filðŸŸ¢e_paðŸŸ¢th'ðŸŸ¢, ðŸŸ¢'w')ðŸŸ¢ ðŸŸ¢asðŸŸ¢ ðŸŸ¢fðŸŸ¢iðŸŸ¢lðŸŸ¢eðŸŸ¢:ðŸŸ¢
						ðŸŸ¢pðŸŸ¢aðŸŸ¢sðŸŸ¢s
				`;

			await testGetNodeStart('python', code);
		});
	});

	// tests for JavaScript and TypeScript: `â¦ƒ...â¦„` delineates the body, `ã€š...ã€›` the type annotations,
	// which are stripped off for JavaScript

	const test1 = dedent`
		function getTextOrNull(documentã€š: doc | nullã€›) {
			if (document === null)
			â¦ƒ    return null;
			return document.getText();
		}â¦„

		// this is a comment`;

	const test2 = dedent`
		function getB(capitalã€š: booleanã€›) {
			if (capital) {
				return "B";
			} else {â¦ƒ
				return "b";
			}â¦„
		}`;

	function mkTestCase(src: string, stripTypes: boolean) {
		if (stripTypes) { src = src.replace(/ã€š.*?ã€›/g, ''); }
		const bodyStart = src.indexOf('â¦ƒ');
		const bodyEnd = src.indexOf('â¦„');
		return {
			before: src.slice(0, bodyStart),
			body: src.slice(bodyStart + 1, bodyEnd),
			after: src.slice(bodyEnd + 1),
		};
	}

	suite('JavaScript isBlockBodyFinished tests', function () {
		runTestCases('javascript', [mkTestCase(test1, true), mkTestCase(test2, true)]);
	});

	suite('TypeScript isBlockBodyFinished tests', function () {
		runTestCases('typescript', [mkTestCase(test1, false), mkTestCase(test2, false)]);
	});
});
