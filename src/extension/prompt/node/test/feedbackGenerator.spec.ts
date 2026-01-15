/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import { parseFeedbackResponse } from '../feedbackGenerator';

suite('parseFeedbackResponse', function () {

	describe('basic parsing', function () {
		test('parses single comment with all fields', function () {
			const response = '1. Line 10 in `file.ts`, bug, high severity: This is a bug.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 9); // 0-indexed
			assert.strictEqual(matches[0].to, 10);
			assert.strictEqual(matches[0].relativeDocumentPath, 'file.ts');
			assert.strictEqual(matches[0].kind, 'bug');
			assert.strictEqual(matches[0].severity, 'high');
			assert.strictEqual(matches[0].content, 'This is a bug.');
		});

		test('parses comment without backticks around path', function () {
			const response = '1. Line 5 in file.ts, performance, medium severity: Slow code.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].relativeDocumentPath, 'file.ts');
		});

		test('parses line range (from-to)', function () {
			const response = '1. Line 10-15 in `file.ts`, bug, high severity: Multiple lines affected.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 9); // 0-indexed
			assert.strictEqual(matches[0].to, 15);
			assert.strictEqual(matches[0].linkLength, 5 + 2 + 2 + 1); // "Line " + "10" + "15" + "-"
		});

		test('defaults kind to "other" when not specified', function () {
			const response = '1. Line 10 in `file.ts`, low severity: Missing kind.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].kind, 'other');
		});

		test('defaults severity to "unknown" when not specified', function () {
			const response = '1. Line 10 in `file.ts`, bug: Missing severity.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].severity, 'unknown');
		});

		test('parses comment with only line and path', function () {
			const response = '1. Line 42 in `utils.js`: Minimal comment.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 41);
			assert.strictEqual(matches[0].to, 42);
			assert.strictEqual(matches[0].relativeDocumentPath, 'utils.js');
			assert.strictEqual(matches[0].kind, 'other');
			assert.strictEqual(matches[0].severity, 'unknown');
			assert.strictEqual(matches[0].content, 'Minimal comment.');
		});
	});

	describe('multiple comments', function () {
		test('parses multiple comments separated by newlines', function () {
			const response = `1. Line 10 in \`file.ts\`, bug, high severity: First issue.

2. Line 20 in \`other.ts\`, performance, low severity: Second issue.`;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 2);
			assert.strictEqual(matches[0].from, 9);
			assert.strictEqual(matches[0].content, 'First issue.');
			assert.strictEqual(matches[1].from, 19);
			assert.strictEqual(matches[1].content, 'Second issue.');
		});

		test('parses comments separated by next numbered item', function () {
			const response = `1. Line 5 in \`a.ts\`, bug: Issue one.
2. Line 10 in \`b.ts\`, bug: Issue two.
3. Line 15 in \`c.ts\`, bug: Issue three.`;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 3);
			assert.strictEqual(matches[0].relativeDocumentPath, 'a.ts');
			assert.strictEqual(matches[1].relativeDocumentPath, 'b.ts');
			assert.strictEqual(matches[2].relativeDocumentPath, 'c.ts');
		});
	});

	describe('dropPartial option', function () {
		test('keeps partial comment when dropPartial is false', function () {
			const response = '1. Line 10 in `file.ts`, bug: Incomplete';
			const matches = parseFeedbackResponse(response, false);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'Incomplete');
		});

		test('drops partial comment when dropPartial is true', function () {
			const response = '1. Line 10 in `file.ts`, bug: Incomplete';
			const matches = parseFeedbackResponse(response, true);

			assert.strictEqual(matches.length, 0);
		});

		test('keeps complete comment when dropPartial is true', function () {
			const response = `1. Line 10 in \`file.ts\`, bug: Complete.

`;
			const matches = parseFeedbackResponse(response, true);

			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].content, 'Complete.');
		});

		test('keeps first comment but drops partial second when dropPartial is true', function () {
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

		test('removes complex multi-line code block with indentation (previously called: Correctly parses reply)', function () {
			const fileContents = `1. Line 33 in \`requestLoggerImpl.ts\`, readability, low severity: The lambda function used in \`onDidChange\` could be extracted into a named function for better readability and reusability.
   \`\`\`typescript
   this._register(workspace.registerTextDocumentContentProvider(ChatRequestScheme.chatRequestScheme, {
       onDidChange: Event.map(this.onDidChangeRequests, this._mapToLatestUri),
       provideTextDocumentContent: (uri) => {
           const uriData = ChatRequestScheme.parseUri(uri.toString());
           if (!uriData) { return \`Invalid URI: \${uri}\`; }

           const entry = uriData.kind === 'latest' ? this._entries[this._entries.length - 1] : this._entries.find(e => e.id === uriData.id);
           if (!entry) { return \`Request not found\`; }

           if (entry.kind === LoggedInfoKind.Element) { return entry.html; }

           return this._renderEntryToMarkdown(entry.id, entry.entry);
       }
   }));

   private _mapToLatestUri = () => Uri.parse(ChatRequestScheme.buildUri({ kind: 'latest' }));
   \`\`\``;
			const matches = parseFeedbackResponse(fileContents);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].from, 32);
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

		test('preserves complete code block in middle of content', function () {
			const response = `1. Line 10 in \`file.ts\`, bug: Use this pattern:
\`\`\`typescript
const x = 1;
\`\`\`
instead of the current approach.

`;
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.ok(matches[0].content.includes('```typescript'));
			assert.ok(matches[0].content.includes('const x = 1;'));
		});
	});

	describe('link offset and length', function () {
		test('calculates linkOffset correctly', function () {
			const response = '1. Line 10 in `file.ts`, bug: Content.';
			const matches = parseFeedbackResponse(response);

			// linkOffset = match.index + num.length + 2 (for ". ")
			// "1" has length 1, so offset = 0 + 1 + 2 = 3 (points to "Line")
			assert.strictEqual(matches[0].linkOffset, 3);
		});

		test('calculates linkLength for single line', function () {
			const response = '1. Line 10 in `file.ts`, bug: Content.';
			const matches = parseFeedbackResponse(response);

			// linkLength = 5 ("Line ") + from.length (2 for "10") = 7
			assert.strictEqual(matches[0].linkLength, 7);
		});

		test('calculates linkLength for line range', function () {
			const response = '1. Line 100-200 in `file.ts`, bug: Content.';
			const matches = parseFeedbackResponse(response);

			// linkLength = 5 ("Line ") + from.length (3) + to.length (3) + 1 ("-") = 12
			assert.strictEqual(matches[0].linkLength, 12);
		});
	});

	describe('path handling', function () {
		test('parses path with subdirectories', function () {
			const response = '1. Line 10 in `src/utils/helpers.ts`, bug: Issue.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.ok(matches[0].relativeDocumentPath?.includes('src'));
			assert.ok(matches[0].relativeDocumentPath?.includes('helpers.ts'));
		});

		test('handles path without backticks', function () {
			const response = '1. Line 10 in src/file.ts, bug: Issue.';
			const matches = parseFeedbackResponse(response);

			assert.strictEqual(matches.length, 1);
			assert.ok(matches[0].relativeDocumentPath?.includes('file.ts'));
		});
	});

	describe('edge cases', function () {
		test('returns empty array for empty response', function () {
			const matches = parseFeedbackResponse('');
			assert.strictEqual(matches.length, 0);
		});

		test('returns empty array for response without valid format', function () {
			const matches = parseFeedbackResponse('This is just some text without the expected format.');
			assert.strictEqual(matches.length, 0);
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

		test('parses all known kinds', function () {
			const kinds = ['bug', 'performance', 'consistency', 'documentation', 'naming', 'readability', 'style', 'other'];
			for (const kind of kinds) {
				const response = `1. Line 10 in \`file.ts\`, ${kind}: Issue.`;
				const matches = parseFeedbackResponse(response);
				assert.strictEqual(matches.length, 1, `Failed for kind: ${kind}`);
				assert.strictEqual(matches[0].kind, kind);
			}
		});
	});
});
