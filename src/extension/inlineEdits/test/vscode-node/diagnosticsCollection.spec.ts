/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { suite, test } from 'vitest';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { Diagnostic, DiagnosticSeverity } from '../../vscode-node/features/diagnosticsBasedCompletions/diagnosticsCompletions';
import { DiagnosticsCollection } from '../../vscode-node/features/diagnosticsCompletionProcessor';

// Helper function to create a mock VS Code diagnostic
function createMockVSCodeDiagnostic(
	message: string,
	range: Range,
	severity: number = 0,
	source?: string,
	code?: string | number
): any {
	return {
		message,
		range: {
			start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
			end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
		},
		severity,
		source,
		code
	};
}

// Helper function to create a Diagnostic from a mock VS Code diagnostic
function createDiagnostic(
	message: string,
	range: Range,
	severity: DiagnosticSeverity = DiagnosticSeverity.Error,
	source?: string,
	code?: string | number
): Diagnostic {
	const mockVSCodeDiagnostic = createMockVSCodeDiagnostic(message, range, severity, source, code);
	return Diagnostic.fromVSCodeDiagnostic(mockVSCodeDiagnostic);
}

suite('DiagnosticsCollection', () => {
	test('isEqualAndUpdate should return true for empty arrays', () => {
		const collection = new DiagnosticsCollection();
		const result = collection.isEqualAndUpdate([]);
		assert.strictEqual(result, true);
	});
	test('isEqualAndUpdate should update diagnostics and return false when different', () => {
		const collection = new DiagnosticsCollection();
		const diagnostic = createDiagnostic(
			'Test error',
			new Range(1, 1, 1, 5)
		);

		const result = collection.isEqualAndUpdate([diagnostic]);

		assert.strictEqual(result, false);
	});
	test('isEqualAndUpdate should return true when diagnostics are equal', () => {
		const collection = new DiagnosticsCollection();
		const diagnostic1 = createDiagnostic('Test error', new Range(1, 1, 1, 5));
		const diagnostic2 = createDiagnostic('Test error', new Range(1, 1, 1, 5));

		collection.isEqualAndUpdate([diagnostic1]);
		const result = collection.isEqualAndUpdate([diagnostic2]);

		assert.strictEqual(result, true);
	});
	test('isEqualAndUpdate should return false when a diagnostics is invalidated', () => {
		const collection = new DiagnosticsCollection();
		const diagnostic1 = createDiagnostic('Test error', new Range(1, 1, 1, 5));
		const diagnostic2 = createDiagnostic('Test error', new Range(1, 1, 1, 5));

		collection.isEqualAndUpdate([diagnostic1]);

		diagnostic1.invalidate();

		const result = collection.isEqualAndUpdate([diagnostic2]);

		assert.strictEqual(result, false);
	});

	suite('applyEdit', () => {
		test('should invalidate when typing numbers at the end of a diagnostic range', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic]);

			// Replace "test" with "test123"
			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(12, 16), 'test123'); // 0-based: 12-15
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);
			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});

		test('should invalidate diagnostic when range shrinks', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 7, 1, 12)); // "world"
			collection.isEqualAndUpdate([diagnostic]);

			// Create an edit that removes "w"
			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(6, 7), ''); // Remove "w"
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});

		test('should update range when content stays the same and range length unchanged', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17));
			collection.isEqualAndUpdate([diagnostic]);

			// Insert " big" without touching the diagnostic range
			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(6, 6), ' big');
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic.isValid(), true);
		});

		test('should invalidate diagnostic when content at range changes with same length', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test"
			collection.isEqualAndUpdate([diagnostic]);

			// Replace "test" with "best"
			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(12, 16), 'best');
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});
		test('should handle range growth with same prefix content', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17));
			collection.isEqualAndUpdate([diagnostic]);

			// "test" becomes "test!" (non-alphanumeric edge)
			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(12, 16), 'test!');
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic.isValid(), true);

			// Range should still point to the original "test" part
			assert.strictEqual(diagnostic.range.startColumn, 13);
			assert.strictEqual(diagnostic.range.endColumn, 17);
		});

		test('should handle range growth with same suffix content', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test"
			collection.isEqualAndUpdate([diagnostic]);

			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(12, 12), 'ab');
			const after = edit.applyOnText(before);

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic.isValid(), true);
			// Range should point to the suffix "test" part
			assert.strictEqual(diagnostic.range.startColumn, 15); // 13 + 2 ("ab")
			assert.strictEqual(diagnostic.range.endColumn, 19);   // 17 + 2 ("ab")
		});

		test('should invalidate when edge character is alphanumeric with prefix match', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test"
			collection.isEqualAndUpdate([diagnostic]);

			const before = new StringText('hello world test');
			const edit = StringEdit.replace(new OffsetRange(16, 16), 'A');
			const after = edit.applyOnText(before);

			// Add A after "test"

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});

		test('should not invalidate when edge character is non-alphanumeric with prefix match', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic]);

			const before = new StringText('hello world test');
			const after = new StringText('hello world test!'); // "test" becomes "test!" (non-alphanumeric edge)

			// Replace "test" with "test!"
			const edit = StringEdit.replace(new OffsetRange(12, 16), 'test!'); // 0-based: 12-15

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic.isValid(), true);
		});

		test('should handle multiple diagnostics correctly', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic1 = createDiagnostic('Error 1', new Range(1, 1, 1, 6));   // "hello" = positions 0-4 (1-based: 1-5), but using 6 for end
			const diagnostic2 = createDiagnostic('Error 2', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic1, diagnostic2]);

			const before = new StringText('hello world test');
			const after = new StringText('hello big world test');

			// Insert "big " at position 6 (0-based)
			const edit = StringEdit.replace(new OffsetRange(6, 6), 'big ');

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic1.isValid(), true);
			assert.strictEqual(diagnostic2.isValid(), true);

			// First diagnostic range should be unchanged
			assert.strictEqual(diagnostic1.range.startColumn, 1);
			assert.strictEqual(diagnostic1.range.endColumn, 6);

			// Second diagnostic range should be shifted by 4 positions ("big ")
			assert.strictEqual(diagnostic2.range.startColumn, 17); // 13 + 4
			assert.strictEqual(diagnostic2.range.endColumn, 21);   // 17 + 4
		});

		test('should handle edge case with empty edge character', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic]);

			const before = new StringText('hello world test');
			const after = new StringText('hello world testx'); // Add 'x' at end

			// Replace "test" with "testx"
			const edit = StringEdit.replace(new OffsetRange(12, 16), 'testx'); // 0-based: 12-15

			const hasInvalidated = collection.applyEdit(before, edit, after);

			// Since 'x' is alphanumeric, should invalidate
			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});

		test('should handle suffix match with non-alphanumeric edge character', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic]);

			const before = new StringText('hello world test');
			const after = new StringText('hello world .test'); // "test" becomes ".test"

			// Replace "test" with ".test"
			const edit = StringEdit.replace(new OffsetRange(12, 16), '.test'); // 0-based: 12-15

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, false);
			assert.strictEqual(diagnostic.isValid(), true);
			// Range should point to the suffix "test" part
			assert.strictEqual(diagnostic.range.startColumn, 14); // 13 + 1 (".")
			assert.strictEqual(diagnostic.range.endColumn, 18);   // 17 + 1 (".")
		});

		test('should handle case where newOffsetRange is null', () => {
			const collection = new DiagnosticsCollection();
			const diagnostic = createDiagnostic('Test error', new Range(1, 13, 1, 17)); // "test" = positions 12-15 (1-based: 13-17)
			collection.isEqualAndUpdate([diagnostic]);

			// Mock applyEditsToRanges to return null (would happen if range is completely removed)
			const before = new StringText('hello world test');
			const after = new StringText('hello world'); // "test" completely removed

			// Remove " test" completely (0-based: positions 11-15)
			const edit = StringEdit.replace(new OffsetRange(11, 16), '');

			const hasInvalidated = collection.applyEdit(before, edit, after);

			assert.strictEqual(hasInvalidated, true);
			assert.strictEqual(diagnostic.isValid(), false);
		});
	});
});
