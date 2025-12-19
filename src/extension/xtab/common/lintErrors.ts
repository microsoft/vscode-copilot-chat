/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiagnosticData } from '../../../platform/inlineEdits/common/dataTypes/diagnosticData';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { LintOptions, LintOptionShowCode, LintOptionWarning } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
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
	constructor(
		private readonly _lintOptions: LintOptions,
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

	private _getRelevantDiagnostics(): readonly DiagnosticDataWithDistance[] {
		let diagnostics = this._diagnostics();

		diagnostics = filterDiagnosticsByDistance(diagnostics, this._lintOptions.maxLineDistance);
		diagnostics = sortDiagnosticsByDistance(diagnostics);
		diagnostics = filterDiagnosticsBySeverity(diagnostics, this._lintOptions.warnings);

		return diagnostics.slice(0, this._lintOptions.maxLints);
	}

	public getFormattedLintErrors(): string {
		const diagnostics = this._getRelevantDiagnostics();
		if (!diagnostics || diagnostics.length === 0) {
			return '';
		}

		const formattedDiagnostics = diagnostics.map(d => formatSingleDiagnostic(d, this._document.lines, this._lintOptions)).join('\n');

		const lintTag = PromptTags.createLintTag(this._lintOptions.tagName);
		return `${lintTag.start}\n${formattedDiagnostics}\n${lintTag.end}`;
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
	// Format: "line:column - severity CODE: message"

	const diagnosticStartPosition = diagnostic.documentRange.getStartPosition();
	const diagnosticEndPosition = diagnostic.documentRange.getEndPosition();

	let codeStr = '';
	if (diagnostic.code) {
		const source = diagnostic.source ? `${diagnostic.source.toUpperCase()}` : '';
		codeStr = ` ${source}${diagnostic.code}`;
	}

	const headerLine = `${diagnosticStartPosition.lineNumber}:${diagnosticStartPosition.column} - ${diagnostic.severity}${codeStr}: ${diagnostic.message}`;

	if (lintOptions.showCode === LintOptionShowCode.NO) {
		return headerLine;
	}

	const codeLines: string[] = [];
	const diagnosticStartLine = diagnosticStartPosition.lineNumber - 1; // 0-based
	const diagnosticEndLine = diagnosticEndPosition.lineNumber - 1; // 0-based

	if (lintOptions.showCode === LintOptionShowCode.YES_WITH_SURROUNDING) {
		// Include line before, the diagnostic line, and line after
		const startLine = Math.max(0, diagnosticStartLine - 1);
		const endLine = Math.min(documentLines.length - 1, diagnosticEndLine + 1);

		for (let i = startLine; i <= endLine; i++) {
			const lineNumber = i; // use 0-based for display
			const lineContent = i < documentLines.length ? documentLines[i] : '';
			codeLines.push(`${lineNumber}|${lineContent}`);
		}
	} else {
		// 'yes' - only include the diagnostic line
		if (diagnosticStartLine < documentLines.length) {
			const lineNumber = diagnosticStartLine;
			codeLines.push(`${lineNumber}|${documentLines[diagnosticStartLine]}`);
		}
	}

	return headerLine + '\n' + codeLines.join('\n');
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