/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LintOptions, LintOptionShowCode, LintOptionWarning } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { TestLanguageDiagnosticsService } from '../../../../platform/languages/common/testLanguageDiagnosticsService';
import { Position } from '../../../../util/vs/editor/common/core/position';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { ensureDependenciesAreSet } from '../../../../util/vs/editor/common/core/text/positionToOffset';
import { DiagnosticSeverity, Range } from '../../../../vscodeTypes';
import { LintErrors } from '../../common/lintErrors';
import { CurrentDocument } from '../../common/xtabCurrentDocument';

describe('LintErrors', () => {
	let diagnosticsService: TestLanguageDiagnosticsService;

	const fileUri = DocumentId.create('file:///test/file.ts').toUri();
	const documentId = DocumentId.create('file:///test/file.ts');

	const defaultLintOptions: LintOptions = {
		tagName: 'linter diagnostics',
		warnings: LintOptionWarning.YES,
		showCode: LintOptionShowCode.NO,
		maxLints: 5,
		maxLineDistance: 10,
	};

	function createDocument(lines: string[], cursorLine: number, cursorColumn: number): CurrentDocument {
		const content = new StringText(lines.join('\n'));
		return new CurrentDocument(content, new Position(cursorLine, cursorColumn));
	}

	function createLintErrors(options: LintOptions, document: CurrentDocument): LintErrors {
		return new LintErrors(
			options,
			documentId,
			document,
			diagnosticsService
		);
	}

	beforeEach(() => {
		ensureDependenciesAreSet();
		diagnosticsService = new TestLanguageDiagnosticsService();
	});

	describe('getFormattedLintErrors', () => {
		it('should return empty string when no diagnostics', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, []);

			const lintErrors = createLintErrors(defaultLintOptions, document);

			expect(lintErrors.getFormattedLintErrors()).toBe('<|linter diagnostics|>\n\n<|/linter diagnostics|>');
		});

		it('should format single error diagnostic without code context', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Missing semicolon',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				}
			]);

			const lintErrors = createLintErrors(defaultLintOptions, document);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('<|linter diagnostics|>');
			expect(result).toContain('1:1 - error: Missing semicolon');
			expect(result).toContain('<|/linter diagnostics|>');
		});

		it('should format diagnostic with code and source', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Variable is never read',
					range: new Range(0, 6, 0, 7),
					severity: DiagnosticSeverity.Error,
					code: { value: '6133', target: 'file:///test' as unknown as import('vscode').Uri },
					source: 'ts'
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('TS6133');
		});

		it('should format diagnostic with numeric code', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Numeric code error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error,
					code: 1234
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('1234');
		});

		it('should format diagnostic with string code', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'String code error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error,
					code: 'E001'
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('E001');
		});

		it('should include code line when showCode is YES', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;', 'const z = 3;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Missing semicolon',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithCode: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES
			};

			const lintErrors = createLintErrors(
				optionsWithCode,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('0|const x = 1;');
		});

		it('should include surrounding lines when showCode is YES_WITH_SURROUNDING', () => {
			const document = createDocument(['line1', 'line2', 'line3', 'line4', 'line5'], 2, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error on line 3',
					range: new Range(2, 0, 2, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithSurrounding: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING
			};

			const lintErrors = createLintErrors(
				optionsWithSurrounding,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('1|line2'); // line before
			expect(result).toContain('2|line3'); // diagnostic line
			expect(result).toContain('3|line4'); // line after
		});

		it('should handle diagnostic at first line with YES_WITH_SURROUNDING', () => {
			const document = createDocument(['line1', 'line2', 'line3'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error on first line',
					range: new Range(0, 0, 0, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithSurrounding: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING
			};

			const lintErrors = createLintErrors(
				optionsWithSurrounding,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('0|line1');
			expect(result).toContain('1|line2');
		});

		it('should handle diagnostic at last line with YES_WITH_SURROUNDING', () => {
			const document = createDocument(['line1', 'line2', 'line3'], 3, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error on last line',
					range: new Range(2, 0, 2, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithSurrounding: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING
			};

			const lintErrors = createLintErrors(
				optionsWithSurrounding,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('1|line2');
			expect(result).toContain('2|line3');
		});

		it('should filter warnings when warnings option is NO', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'This is an error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'This is a warning',
					range: new Range(1, 0, 1, 12),
					severity: DiagnosticSeverity.Warning
				}
			]);

			const optionsNoWarnings: LintOptions = {
				...defaultLintOptions,
				warnings: LintOptionWarning.NO
			};

			const lintErrors = createLintErrors(
				optionsNoWarnings,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('This is an error');
			expect(result).not.toContain('This is a warning');
		});

		it('should include warnings when warnings option is YES', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'This is an error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'This is a warning',
					range: new Range(1, 0, 1, 12),
					severity: DiagnosticSeverity.Warning
				}
			]);

			const optionsWithWarnings: LintOptions = {
				...defaultLintOptions,
				warnings: LintOptionWarning.YES
			};

			const lintErrors = createLintErrors(
				optionsWithWarnings,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('This is an error');
			expect(result).toContain('This is a warning');
		});

		it('should only include errors when warnings option is YES_IF_NO_ERRORS and errors exist', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'This is an error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'This is a warning',
					range: new Range(1, 0, 1, 12),
					severity: DiagnosticSeverity.Warning
				}
			]);

			const optionsYesIfNoErrors: LintOptions = {
				...defaultLintOptions,
				warnings: LintOptionWarning.YES_IF_NO_ERRORS
			};

			const lintErrors = createLintErrors(
				optionsYesIfNoErrors,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('This is an error');
			expect(result).not.toContain('This is a warning');
		});

		it('should include warnings when warnings option is YES_IF_NO_ERRORS and no errors exist', () => {
			const document = createDocument(['const x = 1;', 'const y = 2;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'This is a warning',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Warning
				}
			]);

			const optionsYesIfNoErrors: LintOptions = {
				...defaultLintOptions,
				warnings: LintOptionWarning.YES_IF_NO_ERRORS
			};

			const lintErrors = createLintErrors(
				optionsYesIfNoErrors,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('This is a warning');
		});

		it('should filter diagnostics by distance', () => {
			// Cursor at line 1, diagnostic at line 20 (distance 19)
			const lines = Array(25).fill('line');
			const document = createDocument(lines, 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Near error',
					range: new Range(0, 0, 0, 4),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Far error',
					range: new Range(19, 0, 19, 4),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsSmallDistance: LintOptions = {
				...defaultLintOptions,
				maxLineDistance: 5
			};

			const lintErrors = createLintErrors(
				optionsSmallDistance,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('Near error');
			expect(result).not.toContain('Far error');
		});

		it('should respect maxLints limit', () => {
			const document = createDocument(['line1', 'line2', 'line3', 'line4'], 2, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error 1',
					range: new Range(0, 0, 0, 5),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Error 2',
					range: new Range(1, 0, 1, 5),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Error 3',
					range: new Range(2, 0, 2, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsMaxLints: LintOptions = {
				...defaultLintOptions,
				maxLints: 2
			};

			const lintErrors = createLintErrors(
				optionsMaxLints,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			// Should include Error 3 (closest to cursor at line 2) and one other
			// but not all three
			const errorCount = (result.match(/Error \d/g) || []).length;
			expect(errorCount).toBe(2);
		});

		it('should sort diagnostics by distance (closest first)', () => {
			const document = createDocument(['line1', 'line2', 'line3', 'line4', 'line5'], 3, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Far error',
					range: new Range(0, 0, 0, 5),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Close error',
					range: new Range(2, 0, 2, 5),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Medium error',
					range: new Range(4, 0, 4, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			const closeIndex = result.indexOf('Close error');
			const farIndex = result.indexOf('Far error');
			const mediumIndex = result.indexOf('Medium error');

			// Close error should appear before far error
			expect(closeIndex).toBeLessThan(farIndex);
			expect(closeIndex).toBeLessThan(mediumIndex);
		});

		it('should handle multi-line diagnostics', () => {
			const document = createDocument(['line1', 'line2', 'line3', 'line4', 'line5'], 2, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Multi-line error',
					range: new Range(1, 0, 3, 5),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithSurrounding: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING
			};

			const lintErrors = createLintErrors(
				optionsWithSurrounding,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			// Should include line before diagnostic start (line1), diagnostic lines (line2-line4), and line after diagnostic end (line5)
			expect(result).toContain('0|line1');
			expect(result).toContain('1|line2');
			expect(result).toContain('4|line5');
		});

		it('should handle multi-line diagnostics with YES_WITH_SURROUNDING', () => {
			const document = createDocument(['function foo() {', 'const x = 1;', 'const y = 2;', 'const z = 3;', '}'], 2, 10);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Multi-line scope error',
					range: new Range(1, 0, 3, 15),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithSurrounding: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING
			};

			const lintErrors = createLintErrors(
				optionsWithSurrounding,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			// Should include line before (0|function foo() {), all diagnostic lines, and line after (4|})
			expect(result).toContain('0|function foo() {');
			expect(result).toContain('1|const x = 1;');
			expect(result).toContain('2|const y = 2;');
			expect(result).toContain('3|const z = 3;');
			expect(result).toContain('4|}');
		});

		it('should handle multi-line diagnostics with YES', () => {
			const document = createDocument(['function foo() {', 'const x = 1;', 'const y = 2;', 'const z = 3;', '}'], 2, 10);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Multi-line scope error',
					range: new Range(1, 0, 3, 15),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsWithCode: LintOptions = {
				...defaultLintOptions,
				showCode: LintOptionShowCode.YES
			};

			const lintErrors = createLintErrors(
				optionsWithCode,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			// Should include all diagnostic lines when YES is set
			expect(result).toContain('1|const x = 1;');
			expect(result).toContain('2|const y = 2;');
			expect(result).toContain('3|const z = 3;');
			// Should include the error location and message
			expect(result).toContain('Multi-line scope error');
		});

		it('should use custom tag name', () => {
			const document = createDocument(['const x = 1;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error
				}
			]);

			const optionsCustomTag: LintOptions = {
				...defaultLintOptions,
				tagName: 'custom lint tag'
			};

			const lintErrors = createLintErrors(
				optionsCustomTag,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('<|custom lint tag|>');
			expect(result).toContain('<|/custom lint tag|>');
		});

		it('should handle warning severity correctly', () => {
			const document = createDocument(['const x = 1;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Warning message',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Warning
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('warning: Warning message');
		});

		it('should sort by column distance when line distance is equal', () => {
			const document = createDocument(['line with many characters'], 1, 15);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Far column error',
					range: new Range(0, 0, 0, 4),
					severity: DiagnosticSeverity.Error
				},
				{
					message: 'Close column error',
					range: new Range(0, 14, 0, 18),
					severity: DiagnosticSeverity.Error
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			const closeIndex = result.indexOf('Close column error');
			const farIndex = result.indexOf('Far column error');

			// Close column error should appear before far column error
			expect(closeIndex).toBeLessThan(farIndex);
		});

		it('should handle diagnostic without source', () => {
			const document = createDocument(['const x = 1;'], 1, 1);
			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Error without source',
					range: new Range(0, 0, 0, 12),
					severity: DiagnosticSeverity.Error,
					code: { value: 'E001', target: 'file:///test' as unknown as import('vscode').Uri }
				}
			]);

			const lintErrors = createLintErrors(
				defaultLintOptions,
				document
			);

			const result = lintErrors.getFormattedLintErrors();
			expect(result).toContain('E001');
			expect(result).toContain('Error without source');
		});

		it('should format exact string with code shown NO', () => {
			const document = createDocument([
				'const x = 1;',     // line 0
				'const y = 2;',     // line 1
				'const z = 3;',     // line 2
				'const w = 4;',     // line 3
				'const v = 5;',     // line 4
				'const u = 6;'      // line 5
			], 3, 5);

			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Type mismatch in assignment',
					range: new Range(1, 8, 2, 10),
					severity: DiagnosticSeverity.Error,
					code: { value: '2322', target: 'file:///test' as unknown as import('vscode').Uri },
					source: 'ts'
				},
				{
					message: 'Unused variable',
					range: new Range(3, 6, 4, 10),
					severity: DiagnosticSeverity.Warning,
					code: { value: '6133', target: 'file:///test' as unknown as import('vscode').Uri },
					source: 'ts'
				}
			]);

			const options: LintOptions = {
				tagName: 'linter diagnostics',
				warnings: LintOptionWarning.YES,
				showCode: LintOptionShowCode.NO,
				maxLints: 10,
				maxLineDistance: 20,
			};

			const lintErrors = createLintErrors(options, document);
			const result = lintErrors.getFormattedLintErrors();

			const expected = `<|linter diagnostics|>
4:7 - warning TS6133: Unused variable
2:9 - error TS2322: Type mismatch in assignment
<|/linter diagnostics|>`;

			expect(result).toBe(expected);
		});

		it('should format exact string with multiple multi-line diagnostics, code, source, and YES_WITH_SURROUNDING', () => {
			const document = createDocument([
				'const x = 1;',     // line 0
				'const y = 2;',     // line 1
				'const z = 3;',     // line 2
				'const w = 4;',     // line 3
				'const v = 5;',     // line 4
				'const u = 6;'      // line 5
			], 3, 5);

			diagnosticsService.setDiagnostics(fileUri, [
				{
					message: 'Type mismatch in assignment',
					range: new Range(1, 8, 2, 10),
					severity: DiagnosticSeverity.Error,
					code: { value: '2322', target: 'file:///test' as unknown as import('vscode').Uri },
					source: 'ts'
				},
				{
					message: 'Unused variable',
					range: new Range(3, 6, 4, 10),
					severity: DiagnosticSeverity.Warning,
					code: { value: '6133', target: 'file:///test' as unknown as import('vscode').Uri },
					source: 'ts'
				}
			]);

			const options: LintOptions = {
				tagName: 'linter diagnostics',
				warnings: LintOptionWarning.YES,
				showCode: LintOptionShowCode.YES_WITH_SURROUNDING,
				maxLints: 10,
				maxLineDistance: 20,
			};

			const lintErrors = createLintErrors(options, document);
			const result = lintErrors.getFormattedLintErrors();

			const expected = `<|linter diagnostics|>
4:7 - warning TS6133: Unused variable
2|const z = 3;
3|const w = 4;
4|const v = 5;
5|const u = 6;
2:9 - error TS2322: Type mismatch in assignment
0|const x = 1;
1|const y = 2;
2|const z = 3;
3|const w = 4;
<|/linter diagnostics|>`;

			expect(result).toBe(expected);
		});
	});
});
