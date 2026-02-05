/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiagnosticData } from '../../../platform/inlineEdits/common/dataTypes/diagnosticData';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { LintOptions, LintOptionShowCode, LintOptionWarning } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { BugIndicatingError } from '../../../util/vs/base/common/errors';
import { URI } from '../../../util/vs/base/common/uri';
import { Position } from '../../../util/vs/editor/common/core/position';
import { Range } from '../../../util/vs/editor/common/core/range';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { Diagnostic, DiagnosticSeverity } from '../../../vscodeTypes';
import { PromptTags } from './tags';
import { CurrentDocument } from './xtabCurrentDocument';

export interface LintDiagnosticsContext {
	readonly diagnostics: readonly Diagnostic[];
	readonly cursorLineNumber: number;
}

export class LintErrors {

	private _previousFormttedDiagnostics: readonly DiagnosticDataWithDistance[] | undefined;

	constructor(
		private readonly _documentId: DocumentId,
		private readonly _document: CurrentDocument,
		@ILanguageDiagnosticsService private readonly _langDiagService: ILanguageDiagnosticsService,
	) { }

	private _diagnostics(): readonly DiagnosticDataWithDistance[] {
		const resource = this._documentId.toUri();
		const allDiagnostics = this._langDiagService.getDiagnostics(resource);

		return allDiagnostics.map(diagnostic => {
			const range = new Range(diagnostic.range.start.line + 1, diagnostic.range.start.character + 1, diagnostic.range.end.line + 1, diagnostic.range.end.character + 1);
			const distance = CursorDistance.fromPositions(range.getStartPosition(), this._document.cursorPosition);
			return new DiagnosticDataWithDistance(
				resource,
				diagnostic.message,
				diagnostic.severity === DiagnosticSeverity.Error ? 'error' : 'warning',
				distance,
				range,
				this._document.transformer.getOffsetRange(range),
				diagnostic.code && !(typeof diagnostic.code === 'number') && !(typeof diagnostic.code === 'string') ? diagnostic.code.value : diagnostic.code,
				diagnostic.source
			);
		});
	}

	private _getRelevantDiagnostics(options: LintOptions): readonly DiagnosticDataWithDistance[] {
		let diagnostics = this._diagnostics();

		diagnostics = filterDiagnosticsByDistance(diagnostics, options.maxLineDistance);
		diagnostics = sortDiagnosticsByDistance(diagnostics);
		diagnostics = filterDiagnosticsBySeverity(diagnostics, options.warnings);

		return diagnostics.slice(0, options.maxLints);
	}

	public getFormattedLintErrors(options: LintOptions): string {
		const diagnostics = this._getRelevantDiagnostics(options);
		this._previousFormttedDiagnostics = diagnostics;

		const formattedDiagnostics = diagnostics.map(d => formatSingleDiagnostic(d, this._document.lines, options)).join('\n');

		const lintTag = PromptTags.createLintTag(options.tagName);
		return `${lintTag.start}\n${formattedDiagnostics}\n${lintTag.end}`;
	}

	public lineNumberInPreviousFormattedPrompt(options: LintOptions, lineNumber: number): boolean {
		if (!this._previousFormttedDiagnostics) {
			throw new BugIndicatingError('No previous formatted diagnostics available to check line number against.');
		}

		for (const diagnostic of this._previousFormttedDiagnostics) {
			// Convert diagnostic position (1-based) to 0-based for comparison with formatted output
			if (diagnostic.documentRange.getStartPosition().lineNumber - 1 === lineNumber) {
				return true;
			}

			if (options.showCode === LintOptionShowCode.NO) {
				continue;
			}

			const lineRange = diagnosticsToCodeLineRange(diagnostic.documentRange, options);
			if (lineRange.contains(lineNumber)) {
				return true;
			}
		}

		return false;
	}

	public getData(): string {
		// Create options with everything enabled for comprehensive telemetry
		const telemetryOptions: LintOptions = {
			tagName: 'telemetry',
			warnings: LintOptionWarning.YES,
			showCode: LintOptionShowCode.NO,
			maxLints: 20,
			maxLineDistance: Number.MAX_SAFE_INTEGER, // Include all diagnostics regardless of distance
		};

		const diagnostics = this._getRelevantDiagnostics(telemetryOptions);

		const telemetryDiagnostics: ILintErrorTelemetry[] = diagnostics.map(diagnostic => ({
			line: diagnostic.documentRange.startLineNumber,
			column: diagnostic.documentRange.startColumn,
			endLine: diagnostic.documentRange.endLineNumber,
			endColumn: diagnostic.documentRange.endColumn,
			severity: diagnostic.severity,
			message: diagnostic.message,
			code: diagnostic.code,
			source: diagnostic.source,
			lineDistance: diagnostic.distance.lineDistance,
			formatted: formatSingleDiagnostic(diagnostic, this._document.lines, telemetryOptions),
			formattedCode: formatSingleDiagnostic(diagnostic, this._document.lines, { ...telemetryOptions, showCode: LintOptionShowCode.YES }),
			formattedCodeWithSurrounding: formatSingleDiagnostic(diagnostic, this._document.lines, { ...telemetryOptions, showCode: LintOptionShowCode.YES_WITH_SURROUNDING }),
		}));

		return JSON.stringify(telemetryDiagnostics);
	}
}

/**
 * Formats a single diagnostic with optional code context.
 */
function formatSingleDiagnostic(
	diagnostic: DiagnosticDataWithDistance,
	documentLines: readonly string[],
	lintOptions: LintOptions
): string {
	const headerLine = formatDiagnosticMessage(diagnostic, diagnostic.documentRange);

	if (lintOptions.showCode === LintOptionShowCode.NO) {
		return headerLine;
	}

	const codeLines = formatCodeLines(diagnostic.documentRange, lintOptions, documentLines);
	return headerLine + '\n' + codeLines.join('\n');
}

function formatDiagnosticMessage(diagnostic: DiagnosticDataWithDistance, diagnosticRange: Range): string {
	// Format: "line:column - severity CODE: message"
	let codeStr = '';
	if (diagnostic.code) {
		const source = diagnostic.source ? diagnostic.source.toUpperCase() : '';
		codeStr = ` ${source}${diagnostic.code}`;
	}

	const diagnosticStartPosition = diagnosticRange.getStartPosition();
	const headerLine = `${diagnosticStartPosition.lineNumber - 1}:${diagnosticStartPosition.column - 1} - ${diagnostic.severity}${codeStr}: ${diagnostic.message}`;
	return headerLine;
}

function formatCodeLines(diagnosticRange: Range, lintOptions: LintOptions, documentLines: readonly string[]): string[] {
	const lineRangeToInclude = diagnosticsToCodeLineRange(diagnosticRange, lintOptions);

	const lineRange = lineRangeToInclude.intersect(new OffsetRange(0, documentLines.length));
	if (!lineRange) {
		throw new BugIndicatingError('Unexpected: line range to include is out of document bounds.');
	}

	const codeLines: string[] = [];
	for (let i = lineRange.start; i < lineRange.endExclusive; i++) {
		codeLines.push(formatCodeLine(i, documentLines[i] ?? ''));
	}
	return codeLines;
}

function diagnosticsToCodeLineRange(diagnosticRange: Range, lintOptions: LintOptions): OffsetRange {
	const diagnosticStartLine = diagnosticRange.getStartPosition().lineNumber - 1; // 0-based for rendering and array access
	const diagnosticEndLine = diagnosticRange.getEndPosition().lineNumber - 1; // 0-based for rendering and array access

	let lineRangeToInclude = new OffsetRange(diagnosticStartLine, diagnosticEndLine + 1);
	if (lintOptions.showCode === LintOptionShowCode.YES_WITH_SURROUNDING) {
		lineRangeToInclude = lineRangeToInclude.deltaStart(-1).deltaEnd(1);
	}

	return lineRangeToInclude;
}

function formatCodeLine(lineNumber: number, lineContent: string): string {
	return `${lineNumber}|${lineContent}`;
}

function filterDiagnosticsByDistance(diagnostics: readonly DiagnosticDataWithDistance[], distance: number): readonly DiagnosticDataWithDistance[] {
	return diagnostics.filter(d => d.distance.lineDistance <= distance);
}

function sortDiagnosticsByDistance(diagnostics: readonly DiagnosticDataWithDistance[]): readonly DiagnosticDataWithDistance[] {
	return diagnostics.slice().sort((a, b) => CursorDistance.compareFn(a.distance, b.distance));
}

function filterDiagnosticsBySeverity(diagnostics: readonly DiagnosticDataWithDistance[], warnings: LintOptionWarning): readonly DiagnosticDataWithDistance[] {
	switch (warnings) {
		case LintOptionWarning.NO:
			return diagnostics.filter(d => d.severity === 'error');
		case LintOptionWarning.YES: {
			return diagnostics.filter(d => d.severity === 'error' || d.severity === 'warning');
		}
		case LintOptionWarning.YES_IF_NO_ERRORS: {
			const errorDiagnostics = diagnostics.filter(d => d.severity === 'error');
			return errorDiagnostics.length > 0
				? errorDiagnostics
				: diagnostics.filter(d => d.severity === 'error' || d.severity === 'warning');
		}
	}
}

class CursorDistance {

	static compareFn(a: CursorDistance, b: CursorDistance): number {
		if (a.lineDistance !== b.lineDistance) {
			return a.lineDistance - b.lineDistance;
		}
		return a.columnDistance - b.columnDistance;
	}

	static fromPositions(pos1: Position, pos2: Position): CursorDistance {
		return new CursorDistance(
			Math.abs(pos1.lineNumber - pos2.lineNumber),
			Math.abs(pos1.column - pos2.column)
		);
	}

	constructor(
		public lineDistance: number,
		public columnDistance: number
	) { }
}

class DiagnosticDataWithDistance extends DiagnosticData {

	constructor(
		documentUri: URI,
		message: string,
		severity: 'error' | 'warning',
		public distance: CursorDistance,
		public documentRange: Range,
		range: OffsetRange,
		code: string | number | undefined,
		source: string | undefined,
	) {
		super(documentUri, message, severity, range, code, source);
	}

}

/**
 * Telemetry data structure for a single lint error.
 */
export interface ILintErrorTelemetry {
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly code: string | number | undefined;
	readonly source: string | undefined;
	readonly lineDistance: number;
	readonly formatted: string;
	readonly formattedCode: string;
	readonly formattedCodeWithSurrounding: string;
}