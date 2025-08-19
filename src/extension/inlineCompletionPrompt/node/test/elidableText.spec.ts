/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { ElidableText } from '../elidableText/elidableText';
import { getTokenizer } from '../tokenization/api';

suite('Test ElidableText', function () {
	test('Creating ElidableText from homogeneous structures', function () {
		// from strings
		for (const length of [0, 1, 5, 10, 100]) {
			const text = new ElidableText(Array<string>(length).fill('hello world'));
			assert.strictEqual(text.lines.length, length);
		}
		// from string / number pairs
		for (const length of [0, 1, 5, 10, 100]) {
			const text = new ElidableText(Array<[string, number]>(length).fill(['hello world', 1]));
			assert.strictEqual(text.lines.length, length);
		}
		// from ElidableTexts
		for (const length of [0, 1, 5, 10, 100]) {
			const text = new ElidableText(Array<ElidableText>(length).fill(new ElidableText(['hello world'])));
			assert.strictEqual(text.lines.length, length);
		}
		// from ElidableText / number pairs
		for (const length of [0, 1, 5, 10, 100]) {
			const text = new ElidableText(
				Array<[ElidableText, number]>(length).fill([new ElidableText(['hello world']), 1])
			);
			assert.strictEqual(text.lines.length, length);
		}
	});

	test('Creating ElidableText from heterogeneous structures', function () {
		// from a mixture of strings and ElidableTexts
		for (const length of [0, 1, 5, 10, 100]) {
			const lines = Array<string | ElidableText | [string, number] | [ElidableText, number]>(length);
			for (let i = 0; i < length; i++) {
				// alternate between the four modes
				if (i % 4 === 0) {
					lines[i] = 'hello world';
				} else if (i % 4 === 1) {
					lines[i] = new ElidableText(['hello world']);
				} else if (i % 4 === 2) {
					lines[i] = ['hello world', 1];
				} else {
					lines[i] = [new ElidableText(['hello world']), 1];
				}
			}
			const text = new ElidableText(lines);
			assert.strictEqual(text.lines.length, length);
		}
	});

	test('Elidable texts from multiline blocks', function () {
		const text = new ElidableText([
			'hello world\nhow are you',
			'hello world\nhow are you\ngoodbye',
			'hello world\nhow are you\ngoodbye\nfarewell',
			'hello world\nhow are you\ngoodbye\nfarewell\nbye',
			'hello world\nhow are you\ngoodbye\nfarewell\nbye\nsee you',
		]);
		assert.strictEqual(text.lines.length, 20);
	});

	test('Elidable texts make prompts within their budget, converging to the original text', function () {
		const originalText = `
      foo bar baz
      foo bar baz
      They just kept talking and talking the whole line long. It was so long
      hi
      hello world
      how are you
      goodbye
      farewell
      bye
      see you
    `;
		const text = new ElidableText([originalText]);
		for (const budget of [1, 5, 10, 100, 1000]) {
			try {
				const prompt = text.elide(budget).getText();
				assert.ok(getTokenizer().tokenLength(prompt) <= budget);
				if (budget > getTokenizer().tokenLength(originalText)) {
					assert.strictEqual(prompt, originalText);
				}
			} catch (e) {
				const castError = e as { message: string };
				// it's ok if the error has a message field, that is "maxTokens must be larger than the ellipsis length" and the budget is indeed smaller than the ellipsis length
				//expect(castError.message).toBe("maxTokens must be larger than the ellipsis length");
				assert.strictEqual(castError.message, 'maxTokens must be larger than the ellipsis length');
				assert.ok(getTokenizer().tokenLength('[...]' + '\n') > budget);
			}
		}
	});

	test('Lower worth lines are removed first', function () {
		const text = new ElidableText([
			['hello world 5', 0.5],
			['hello world 3', 0.3],
			['hello world 0', 0.0],
			['hello world 2', 0.2],
			['hello world 1', 0.1],
			['hello world 4', 0.4],
			['hello world 6', 0.6],
		]);
		for (const multiple of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			const prompt = text.elide(6 * multiple);
			// for each number in there, expect the higher ones to be in there as well
			for (let i = 0; i < 6; i++) {
				if (prompt.getText().includes(`hello world ${i}`)) {
					assert.ok(prompt.getText().includes(`hello world ${i + 1}`));
				}
			}
		}
	});

	test('Carries metadata', function () {
		const metadata = new Map<string, string>();
		metadata.set('key', 'value');
		const text = new ElidableText(
			[
				['hello world 5', 0.5],
				['hello world 3', 0.3],
				['hello world 0', 0.0],
				['hello world 2', 0.2],
				['hello world 1', 0.1],
				['hello world 4', 0.4],
				['hello world 6', 0.6],
			],
			metadata,
			getTokenizer()
		);
		const lines = text.elide(100).getLines();

		for (const line of lines) {
			assert.strictEqual(line.metadata?.get('key'), 'value');
		}
	});

	test('Return ellipses if text cannot fit into the budget', function () {
		const tokenizer = getTokenizer();
		const text = 'A very long line that exceeds the budget';
		const textTokenLength = tokenizer.tokenLength(text);
		const elidableText = new ElidableText([text]);

		const elidedText = elidableText.elide(textTokenLength);
		assert.deepStrictEqual(elidedText.getText(), '[...]');
	});
});
