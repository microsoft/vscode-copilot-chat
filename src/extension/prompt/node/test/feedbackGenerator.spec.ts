/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import type { EndOfLine, TextDocument, TextLine } from 'vscode';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { ReviewRequest } from '../../../../platform/review/common/reviewService';
import { Position, Range, Uri } from '../../../../vscodeTypes';
import { CurrentChangeInput } from '../../../prompts/node/feedback/currentChange';
import { parseFeedbackResponse, parseReviewComments } from '../feedbackGenerator';

class MockTextDocument implements TextDocument {
	readonly uri: Uri;
	readonly fileName: string;
	readonly isUntitled = false;
	readonly languageId: string;
	readonly version = 1;
	readonly isDirty = false;
	readonly isClosed = false;
	readonly eol: EndOfLine = 1;
	readonly encoding = 'utf8';
	private readonly _lines: string[];

	constructor(uri: Uri, content: string, languageId = 'typescript') {
		this.uri = uri;
		this.fileName = uri.fsPath;
		this.languageId = languageId;
		this._lines = content.split('\n');
	}

	get lineCount(): number {
		return this._lines.length;
	}

	lineAt(lineOrPosition: number | Position): TextLine {
		const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
		if (lineNumber < 0 || lineNumber >= this._lines.length) {
			throw new Error('Invalid line number');
		}
		const text = this._lines[lineNumber];
		return {
			lineNumber,
			text,
			range: new Range(lineNumber, 0, lineNumber, text.length),
			rangeIncludingLineBreak: new Range(lineNumber, 0, lineNumber + 1, 0),
			firstNonWhitespaceCharacterIndex: text.match(/^\s*/)?.[0].length ?? 0,
			isEmptyOrWhitespace: text.trim().length === 0,
		};
	}

	getText(range?: Range): string {
		if (!range) {
			return this._lines.join('\n');
		}
		const start = range.start;
		const end = range.end;
		if (start.line === end.line) {
			return this._lines[start.line].substring(start.character, end.character);
		}
		const lines: string[] = [];
		lines.push(this._lines[start.line].substring(start.character));
		for (let i = start.line + 1; i < end.line; i++) {
			lines.push(this._lines[i]);
		}
		lines.push(this._lines[end.line].substring(0, end.character));
		return lines.join('\n');
	}

	offsetAt(position: Position): number {
		let offset = 0;
		for (let i = 0; i < position.line; i++) {
			offset += this._lines[i].length + 1;
		}
		return offset + position.character;
	}

	positionAt(offset: number): Position {
		let remaining = offset;
		for (let line = 0; line < this._lines.length; line++) {
			if (remaining <= this._lines[line].length) {
				return new Position(line, remaining);
			}
			remaining -= this._lines[line].length + 1;
		}
		return new Position(this._lines.length - 1, this._lines[this._lines.length - 1].length);
	}

	getWordRangeAtPosition(_position: Position): Range | undefined {
		return undefined;
	}

	validateRange(range: Range): Range {
		return range;
	}

	validatePosition(position: Position): Position {
		return position;
	}

	save(): Thenable<boolean> {
		return Promise.resolve(true);
	}
}

function createTestSnapshot(uri: Uri, content: string, languageId = 'typescript'): TextDocumentSnapshot {
	const mockDoc = new MockTextDocument(uri, content, languageId);
	return TextDocumentSnapshot.create(mockDoc);
}

function createReviewRequest(overrides?: Partial<ReviewRequest>): ReviewRequest {
	return {
		source: 'vscodeCopilotChat',
		promptCount: 1,
		messageId: 'test-message-id',
		inputType: 'change',
		inputRanges: [],
		...overrides,
	};
}

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

suite('parseReviewComments', function () {

	describe('basic parsing', function () {
		test('parses valid comment and creates ReviewComment', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2\nline 3\nline 4';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 4, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 2 in `file.ts`, bug, high severity: This is a bug.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			assert.strictEqual(comments[0].kind, 'bug');
			assert.strictEqual(comments[0].severity, 'high');
			assert.strictEqual(comments[0].body.valueOf, 'This is a bug.');
			assert.strictEqual(comments[0].uri, uri);
			assert.strictEqual(comments[0].languageId, 'typescript');
			assert.strictEqual(comments[0].originalIndex, 0);
			assert.strictEqual(comments[0].actionCount, 0);
			assert.strictEqual(comments[0].request, request);
		});

		test('parses multiple comments from same input', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 5, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = `1. Line 2 in \`file.ts\`, bug: First issue.

2. Line 4 in \`file.ts\`, performance: Second issue.

`;

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 2);
			assert.strictEqual(comments[0].body.valueOf, 'First issue.');
			assert.strictEqual(comments[0].originalIndex, 0);
			assert.strictEqual(comments[1].body.valueOf, 'Second issue.');
			assert.strictEqual(comments[1].originalIndex, 1);
		});
	});

	describe('kind filtering', function () {
		test('filters out unknown kind', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 2, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 2 in `file.ts`, unknownKind: Should be filtered.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 0);
		});

		test('accepts all known kinds', function () {
			const knownKinds = ['bug', 'performance', 'consistency', 'documentation', 'naming', 'readability', 'style', 'other'];
			const uri = Uri.file('/test/file.ts');
			const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 19, 7), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = knownKinds.map((kind, i) => `${i + 1}. Line ${i + 1} in \`file.ts\`, ${kind}: Issue ${i + 1}.`).join('\n\n') + '\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, knownKinds.length);
			knownKinds.forEach((kind, i) => {
				assert.strictEqual(comments[i].kind, kind);
			});
		});
	});

	describe('input matching', function () {
		test('skips comment when relativeDocumentPath does not match any input', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'different.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 1, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 1 in `file.ts`, bug: Should be skipped.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 0);
		});

		test('matches correct input from multiple inputs', function () {
			const uri1 = Uri.file('/test/first.ts');
			const uri2 = Uri.file('/test/second.ts');
			const content = 'line 0\nline 1';
			const snapshot1 = createTestSnapshot(uri1, content);
			const snapshot2 = createTestSnapshot(uri2, content);
			const input: CurrentChangeInput[] = [
				{
					document: snapshot1,
					relativeDocumentPath: 'first.ts',
					change: {
						repository: {} as any,
						uri: uri1,
						hunks: [{ range: new Range(0, 0, 1, 6), text: content }]
					}
				},
				{
					document: snapshot2,
					relativeDocumentPath: 'second.ts',
					change: {
						repository: {} as any,
						uri: uri2,
						hunks: [{ range: new Range(0, 0, 1, 6), text: content }]
					}
				}
			];
			const request = createReviewRequest();
			const message = '1. Line 1 in `second.ts`, bug: Found in second file.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			assert.strictEqual(comments[0].uri, uri2);
		});
	});

	describe('line clamping', function () {
		test('uses line 0 correctly when Line 1 is specified (0-indexed)', function () {
			const uri = Uri.file('/test/file.ts');
			const content = '  indented line\nline 1';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 1, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			// Line 1 in the message becomes 0 after 0-indexing
			const message = '1. Line 1 in `file.ts`, bug: First line.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			// Range should start at line 0
			assert.strictEqual(comments[0].range.start.line, 0);
			// firstNonWhitespaceCharacterIndex for "  indented line" is 2
			assert.strictEqual(comments[0].range.start.character, 2);
		});

		test('clamps line number exceeding lineCount', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nlast line';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 2, 9), text: content }]
				}
			}];
			const request = createReviewRequest();
			// Line 100 is way beyond lineCount of 3
			const message = '1. Line 1-100 in `file.ts`, bug: Should clamp to end.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			// End line should be clamped to lineCount-1 = 2
			assert.strictEqual(comments[0].range.end.line, 2);
		});
	});

	describe('range intersection filtering', function () {
		test('filters out comment outside change hunk range', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2\nline 3\nline 4';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					// Change only affects lines 0-1
					hunks: [{ range: new Range(0, 0, 1, 6), text: 'line 0\nline 1' }]
				}
			}];
			const request = createReviewRequest();
			// Comment on line 4 which is outside the hunk range
			const message = '1. Line 5 in `file.ts`, bug: Outside hunk range.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 0);
		});

		test('includes comment inside change hunk range', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 2, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 2 in `file.ts`, bug: Inside hunk range.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
		});

		test('uses selection range for filtering when selection is provided', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2\nline 3\nline 4';
			const snapshot = createTestSnapshot(uri, content);
			const selection = new Range(2, 0, 3, 6);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				selection
			}];
			const request = createReviewRequest({ inputType: 'selection' });

			// Comment on line 1 (outside selection)
			const messageOutside = '1. Line 1 in `file.ts`, bug: Outside selection.\n\n';
			const commentsOutside = parseReviewComments(request, input, messageOutside);
			assert.strictEqual(commentsOutside.length, 0);

			// Comment on line 3 (inside selection)
			const messageInside = '1. Line 3 in `file.ts`, bug: Inside selection.\n\n';
			const commentsInside = parseReviewComments(request, input, messageInside);
			assert.strictEqual(commentsInside.length, 1);
		});

		test('includes comment when no filterRanges (no selection or change)', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts'
				// No selection or change
			}];
			const request = createReviewRequest();
			const message = '1. Line 1 in `file.ts`, bug: No filter ranges.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
		});

		test('includes comment when intersecting any of multiple hunks', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [
						{ range: new Range(0, 0, 1, 6), text: 'line 0\nline 1' },
						{ range: new Range(4, 0, 5, 6), text: 'line 4\nline 5' }
					]
				}
			}];
			const request = createReviewRequest();

			// Comment on line 5 intersects second hunk
			const message = '1. Line 5 in `file.ts`, bug: In second hunk.\n\n';
			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
		});
	});

	describe('dropPartial parameter', function () {
		test('passes dropPartial to parseFeedbackResponse', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0\nline 1';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 1, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			// Partial response (no terminating newline)
			const partialMessage = '1. Line 1 in `file.ts`, bug: Partial';

			// dropPartial = false keeps the partial comment
			const commentsKept = parseReviewComments(request, input, partialMessage, false);
			assert.strictEqual(commentsKept.length, 1);

			// dropPartial = true drops the partial comment
			const commentsDropped = parseReviewComments(request, input, partialMessage, true);
			assert.strictEqual(commentsDropped.length, 0);
		});
	});

	describe('edge cases', function () {
		test('returns empty array for empty message', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 0, 6), text: content }]
				}
			}];
			const request = createReviewRequest();

			const comments = parseReviewComments(request, input, '');

			assert.strictEqual(comments.length, 0);
		});

		test('returns empty array when no inputs provided', function () {
			const request = createReviewRequest();
			const message = '1. Line 1 in `file.ts`, bug: No inputs.\n\n';

			const comments = parseReviewComments(request, [], message);

			assert.strictEqual(comments.length, 0);
		});

		test('sets correct range with firstNonWhitespaceCharacterIndex', function () {
			const uri = Uri.file('/test/file.ts');
			const content = '    indented content here';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 0, 25), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 1 in `file.ts`, bug: Indented line.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			// Start character should be firstNonWhitespaceCharacterIndex (4 spaces)
			assert.strictEqual(comments[0].range.start.character, 4);
			// End character should be lastNonWhitespaceCharacterIndex (25 - no trailing whitespace)
			assert.strictEqual(comments[0].range.end.character, 25);
		});

		test('handles line range spanning multiple lines', function () {
			const uri = Uri.file('/test/file.ts');
			const content = '  line 0\nline 1\n  line 2 with trailing  ';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 2, 27), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 1-3 in `file.ts`, bug: Multi-line issue.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			// Start: line 0, firstNonWhitespaceCharacterIndex = 2
			assert.strictEqual(comments[0].range.start.line, 0);
			assert.strictEqual(comments[0].range.start.character, 2);
			// End: line 2, lastNonWhitespaceCharacterIndex for "  line 2 with trailing  " is 22 (trimEnd removes trailing spaces)
			assert.strictEqual(comments[0].range.end.line, 2);
			assert.strictEqual(comments[0].range.end.character, 22);
		});

		test('preserves document reference in comment', function () {
			const uri = Uri.file('/test/file.ts');
			const content = 'line 0';
			const snapshot = createTestSnapshot(uri, content);
			const input: CurrentChangeInput[] = [{
				document: snapshot,
				relativeDocumentPath: 'file.ts',
				change: {
					repository: {} as any,
					uri,
					hunks: [{ range: new Range(0, 0, 0, 6), text: content }]
				}
			}];
			const request = createReviewRequest();
			const message = '1. Line 1 in `file.ts`, bug: Check document.\n\n';

			const comments = parseReviewComments(request, input, message);

			assert.strictEqual(comments.length, 1);
			assert.strictEqual(comments[0].document, snapshot);
		});
	});
});
