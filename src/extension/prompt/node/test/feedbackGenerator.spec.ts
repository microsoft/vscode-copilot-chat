/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import { parseFeedbackResponse } from '../feedbackGenerator';

suite('parseFeedbackResponse', function () {

	describe('basic parsing', function () {
		test('parses single comment with all fields including linkOffset and linkLength', function () {
			const response = '1. Line 10 in `file.ts`, bug, high severity: This is a bug.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 9); // 0-indexed
			assert.strictEqual(matches[0].to, 10);
			assert.strictEqual(matches[0].relativeDocumentPath, 'file.ts');
			assert.strictEqual(matches[0].kind, 'bug');
			assert.strictEqual(matches[0].severity, 'high');
			assert.strictEqual(matches[0].content, 'This is a bug.');
			// linkOffset = match.index + num.length + 2 = 0 + 1 + 2 = 3
			assert.strictEqual(matches[0].linkOffset, 3);
			// linkLength = 5 ("Line ") + from.length (2 for "10") = 7
			assert.strictEqual(matches[0].linkLength, 7);
		});

		test('parses comment without backticks around path', function () {
			const response = '1. Line 5 in file.ts, performance, medium severity: Slow code.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].relativeDocumentPath, 'file.ts');
		});

		test('parses line range (from-to) with correct linkLength', function () {
			const response = '1. Line 10-15 in `file.ts`, bug, high severity: Multiple lines affected.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 9); // 0-indexed
			assert.strictEqual(matches[0].to, 15);
			// linkLength = 5 ("Line ") + from.length (2) + to.length (2) + 1 ("-") = 10
			assert.strictEqual(matches[0].linkLength, 5 + 2 + 2 + 1);
		});

		test('defaults kind to "other" and severity to "unknown" when not specified', function () {
			const response = '1. Line 42 in `utils.js`: Minimal comment.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].kind, 'other');
			assert.strictEqual(matches[0].severity, 'unknown');
		});

		test('parses comment with extra text before "in" keyword', function () {
			const response = '1. Line 10 (modified) in `file.ts`, bug: Issue with extra text.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 9);
			assert.strictEqual(matches[0].relativeDocumentPath, 'file.ts');
		});
	});

	describe('multiple comments', function () {
		test('parses multiple comments separated by newlines or next numbered item', function () {
			const response = `1. Line 10 in \`file.ts\`, bug, high severity: First issue.

2. Line 20 in \`other.ts\`, performance, low severity: Second issue.
3. Line 30 in \`third.ts\`, bug: Third issue.`;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 3);
			assert.strictEqual(matches[0].content, 'First issue.');
			assert.strictEqual(matches[1].content, 'Second issue.');
			assert.strictEqual(matches[2].content, 'Third issue.');
		});
	});

	describe('dropPartial option', function () {
		test('keeps partial comment when dropPartial is false, drops when true', function () {
			const partialResponse = '1. Line 10 in `file.ts`, bug: Incomplete';

			// dropPartial = false (default) keeps partial
			const matchesKept = parseFeedbackResponse(partialResponse, false);
			assert.strictEqual(matchesKept.length, 1);
			assert.strictEqual(matchesKept[0].content, 'Incomplete');

			// dropPartial = true drops partial
			const matchesDropped = parseFeedbackResponse(partialResponse, true);
			assert.strictEqual(matchesDropped.length, 0);
		});

		test('keeps first complete comment but drops partial second when dropPartial is true', function () {
			const response = `1. Line 10 in \`file.ts\`, bug: First complete.

2. Line 20 in \`other.ts\`, bug: Partial`;
			const matches = parseFeedbackResponse(response, true);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'First complete.');
		});
	});

	describe('code block handling', function () {
		test('removes trailing complete code block', function () {
			const response = `1. Line 33 in \`file.ts\`, readability, low severity: The lambda function could be extracted.
\`\`\`typescript
const extracted = () => doSomething();
\`\`\``;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'The lambda function could be extracted.');
			assert.strictEqual(matches[0].content.indexOf('```'), -1);
		});

		test('removes broken code block (odd number of markers)', function () {
			const response = '1. Line 10 in `file.ts`, bug: Here is some code:\n```typescript\nconst x = 1;';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'Here is some code:');
		});

		test('preserves inline code (single backticks)', function () {
			const response = '1. Line 10 in `file.ts`, bug: The variable `foo` should be renamed.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'The variable `foo` should be renamed.');
		});

		test('removes trailing ``` via broken block handler when no opening marker exists', function () {
			const response = '1. Line 10 in `file.ts`, bug: Some text ending with ```\n\n';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			// Since there's no matching opening ```, the trailing ``` removal fails (i === -1),
			// but the broken block handler (odd count) removes it
			assert.strictEqual(matches[0].content, 'Some text ending with');
		});

		test('preserves complete code block in middle but removes trailing code block', function () {
			const response = `1. Line 10 in \`file.ts\`, bug: Example:
\`\`\`typescript
const x = 1;
\`\`\`
Fix:
\`\`\`typescript
const y = 2;
\`\`\``;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			// Should keep the first code block but remove the trailing one
			assert.ok(matches[0].content.includes('Example:'));
			assert.ok(matches[0].content.includes('```typescript'));
			assert.ok(matches[0].content.includes('const x = 1;'));
			assert.strictEqual(matches[0].content.includes('const y = 2;'), false);
		});
	});

	describe('path handling', function () {
		test('normalizes path separators for subdirectories', function () {
			const response = '1. Line 10 in `src/utils/helpers.ts`, bug: Issue.\n\n';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			// On Windows, forward slashes should be converted to backslashes
			// On Unix, paths stay with forward slashes
			const pathSep = require('path').sep;
			if (pathSep === '\\') {
				assert.strictEqual(matches[0].relativeDocumentPath, 'src\\utils\\helpers.ts');
			} else {
				assert.strictEqual(matches[0].relativeDocumentPath, 'src/utils/helpers.ts');
			}
		});
	});

	describe('edge cases', function () {
		test('returns empty array for empty or invalid response', function () {
			assert.strictEqual(parseFeedbackResponse('').length, 0);
			assert.strictEqual(parseFeedbackResponse('This is just some text without the expected format.').length, 0);
		});

		test('handles line number 1 correctly (0-indexed)', function () {
			const response = '1. Line 1 in `file.ts`, bug: First line issue.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 0);
			assert.strictEqual(matches[0].to, 1);
		});

		test('trims whitespace from content', function () {
			const response = '1. Line 10 in `file.ts`, bug:    Spaces around content.   ';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'Spaces around content.');
		});

		test('handles multiline content before next comment', function () {
			const response = `1. Line 10 in \`file.ts\`, bug: This is a longer
description that spans
multiple lines.

2. Line 20 in \`other.ts\`, bug: Next issue.`;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 2);
			assert.ok(matches[0].content.includes('longer'));
			assert.ok(matches[0].content.includes('multiple lines.'));
		});

		test('handles multi-digit item numbers for linkOffset calculation', function () {
			const response = '10. Line 5 in `file.ts`, bug: Issue.\n\n';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			// linkOffset = match.index + num.length + 2 = 0 + 2 + 2 = 4
			assert.strictEqual(matches[0].linkOffset, 4);
		});
	});
});
