/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { ILanguageDiagnosticsService } from '../../../../../platform/languages/common/languageDiagnosticsService';
import { Diagnostic, DiagnosticSeverity, Range, Uri } from '../../../../../vscodeTypes';
import { findDiagnosticForSelectionAndPrompt } from '../fixSelection';

// Mock implementation of ILanguageDiagnosticsService for testing
class MockLanguageDiagnosticsService implements ILanguageDiagnosticsService {
	declare readonly _serviceBrand: undefined;

	private diagnostics: Map<string, vscode.Diagnostic[]> = new Map();

	onDidChangeDiagnostics!: vscode.Event<vscode.DiagnosticChangeEvent>;

	constructor(diagnosticsMap?: Map<string, vscode.Diagnostic[]>) {
		if (diagnosticsMap) {
			this.diagnostics = diagnosticsMap;
		}
	}

	setDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
		this.diagnostics.set(uri.toString(), diagnostics);
	}

	getDiagnostics(resource: vscode.Uri): vscode.Diagnostic[] {
		return this.diagnostics.get(resource.toString()) || [];
	}

	getAllDiagnostics(): [vscode.Uri, vscode.Diagnostic[]][] {
		return [];
	}

	waitForNewDiagnostics(_resource: vscode.Uri, _token: vscode.CancellationToken, _timeout?: number): Promise<vscode.Diagnostic[]> {
		return Promise.resolve([]);
	}
}

function createDiagnostic(message: string, startLine: number, startChar: number, endLine: number, endChar: number, severity: DiagnosticSeverity = DiagnosticSeverity.Error): vscode.Diagnostic {
	return new Diagnostic(
		new Range(startLine, startChar, endLine, endChar),
		message,
		severity
	);
}

describe('findDiagnosticForSelectionAndPrompt', () => {
	describe('basic functionality', () => {
		it('returns empty array when no diagnostics exist', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const selection = new Range(0, 0, 0, 10);

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toEqual([]);
		});

		it('returns diagnostics that intersect with selection', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic = createDiagnostic('Error message', 5, 0, 5, 20);

			service.setDiagnostics(uri, [diagnostic]);
			const selection = new Range(5, 5, 5, 15);

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(1);
			expect(result[0].message).toBe('Error message');
		});

		it('returns empty array when diagnostics do not intersect with selection', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic = createDiagnostic('Error on line 10', 10, 0, 10, 20);

			service.setDiagnostics(uri, [diagnostic]);
			const selection = new Range(0, 0, 0, 10);  // Selection on line 0

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toEqual([]);
		});
	});

	describe('multiple diagnostics', () => {
		it('returns all diagnostics that intersect with selection', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic1 = createDiagnostic('Error 1', 5, 0, 5, 10);
			const diagnostic2 = createDiagnostic('Error 2', 5, 15, 5, 25);
			const diagnostic3 = createDiagnostic('Error on another line', 10, 0, 10, 10);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2, diagnostic3]);
			const selection = new Range(5, 0, 5, 30);  // Spans both errors on line 5

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(2);
			expect(result.map(d => d.message)).toContain('Error 1');
			expect(result.map(d => d.message)).toContain('Error 2');
		});

		it('returns only intersecting diagnostics', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic1 = createDiagnostic('Intersecting', 5, 0, 5, 20);
			const diagnostic2 = createDiagnostic('Non-intersecting', 10, 0, 10, 20);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2]);
			const selection = new Range(5, 5, 5, 15);

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(1);
			expect(result[0].message).toBe('Intersecting');
		});
	});

	describe('prompt filtering', () => {
		it('filters diagnostics by prompt message when prompt is provided', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic1 = createDiagnostic('Cannot find name \'foo\'', 5, 0, 5, 10);
			const diagnostic2 = createDiagnostic('Property does not exist', 5, 15, 5, 25);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2]);
			const selection = new Range(5, 0, 5, 30);
			const prompt = 'Fix the error: Cannot find name \'foo\'';

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, prompt);

			expect(result).toHaveLength(1);
			expect(result[0].message).toBe('Cannot find name \'foo\'');
		});

		it('returns all intersecting diagnostics when prompt does not match any diagnostic message', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic1 = createDiagnostic('Error 1', 5, 0, 5, 10);
			const diagnostic2 = createDiagnostic('Error 2', 5, 15, 5, 25);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2]);
			const selection = new Range(5, 0, 5, 30);
			const prompt = 'This prompt does not contain any diagnostic messages';

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, prompt);

			// When no diagnostics match the prompt, return all intersecting diagnostics
			expect(result).toHaveLength(2);
		});

		it('returns filtered diagnostics when prompt matches some diagnostic messages', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			// The filtering checks if the diagnostic message is contained in the prompt (prompt.includes(d.message))
			const diagnostic1 = createDiagnostic('undefined is not a function', 5, 0, 5, 10);
			const diagnostic2 = createDiagnostic('Type error', 5, 15, 5, 25);
			// diagnostic3's message is NOT contained in the prompt (even though it contains similar words)
			const diagnostic3 = createDiagnostic('null reference error', 5, 30, 5, 40);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2, diagnostic3]);
			const selection = new Range(5, 0, 5, 50);
			// Only diagnostic1's message appears verbatim in this prompt
			const prompt = 'Please fix the undefined is not a function error in my code';

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, prompt);

			// Should return only the diagnostics whose message is contained in the prompt
			expect(result).toHaveLength(1);
			expect(result[0].message).toBe('undefined is not a function');
		});

		it('handles empty prompt same as undefined prompt', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic = createDiagnostic('Error message', 5, 0, 5, 20);

			service.setDiagnostics(uri, [diagnostic]);
			const selection = new Range(5, 5, 5, 15);

			// Empty string is falsy, so it should behave like no prompt
			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, '');

			expect(result).toHaveLength(1);
		});
	});

	describe('selection edge cases', () => {
		it('works with single-point selection', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic = createDiagnostic('Error at cursor', 5, 0, 5, 20);

			service.setDiagnostics(uri, [diagnostic]);
			const selection = new Range(5, 10, 5, 10);  // Single point

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(1);
		});

		it('works with multi-line selection', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic1 = createDiagnostic('Error on line 5', 5, 0, 5, 20);
			const diagnostic2 = createDiagnostic('Error on line 7', 7, 0, 7, 20);
			const diagnostic3 = createDiagnostic('Error on line 15', 15, 0, 15, 20);

			service.setDiagnostics(uri, [diagnostic1, diagnostic2, diagnostic3]);
			const selection = new Range(4, 0, 8, 0);  // Lines 4-8

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(2);
			expect(result.map(d => d.message)).toContain('Error on line 5');
			expect(result.map(d => d.message)).toContain('Error on line 7');
		});

		it('handles selection that partially overlaps diagnostic range', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const diagnostic = createDiagnostic('Wide diagnostic', 5, 0, 5, 100);

			service.setDiagnostics(uri, [diagnostic]);
			const selection = new Range(5, 90, 5, 110);  // Partially overlaps at the end

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(1);
		});
	});

	describe('severity handling', () => {
		it('returns diagnostics of all severities', () => {
			const service = new MockLanguageDiagnosticsService();
			const uri = Uri.file('/test/file.ts');
			const error = createDiagnostic('Error', 5, 0, 5, 10, DiagnosticSeverity.Error);
			const warning = createDiagnostic('Warning', 5, 15, 5, 25, DiagnosticSeverity.Warning);
			const info = createDiagnostic('Info', 5, 30, 5, 40, DiagnosticSeverity.Information);
			const hint = createDiagnostic('Hint', 5, 45, 5, 55, DiagnosticSeverity.Hint);

			service.setDiagnostics(uri, [error, warning, info, hint]);
			const selection = new Range(5, 0, 5, 60);

			const result = findDiagnosticForSelectionAndPrompt(service, uri, selection, undefined);

			expect(result).toHaveLength(4);
		});
	});
});
