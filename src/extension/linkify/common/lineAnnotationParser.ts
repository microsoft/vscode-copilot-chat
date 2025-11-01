/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// General, extensible parser for line annotations following a file path.
// Supported patterns (single-line anchor uses first line in range):
//
// Parenthesized forms:
//   (line 42)
//   (lines 10-12) (hyphen / en/em dash / through|thru|to connectors)
//
// Prose forms (any preceding words ignored; we scan tokens):
//   on line 45
//   at line 33
//   line 9
//   lines 3 to 7
//   lines 5 through 9
//   lines 6–11
//   Ln 22 / ln 22 / l 22
//   is located at lines 77–85
//   is found at lines 5-9
//   is at lines 6 through 11
//
// We intentionally only expose the start line (zero-based) because downstream
// logic currently navigates to a single line even if a range was referenced.
// Extending to full range selection would involve carrying an endLine as well.
//
// Design notes:
// - Token-based approach avoids brittle giant regex and makes future synonym
//   additions trivial (expand LINE_TOKENS or RANGE_CONNECTORS sets).
// - Max scan limits ensure we do not waste time over very long trailing text.
// - We ignore invalid ranges like "lines 10 through" (missing second number)
//   but still treat the first number as the target line.
// - Returned raw snippet is a lightweight reconstruction of matched tokens for
//   potential future highlighting or telemetry.

const RANGE_CONNECTORS = new Set(['-', '–', '—', 'to', 'through', 'thru']);
const LINE_TOKENS = new Set(['line', 'lines', 'ln', 'l']);

export interface ParsedLineAnnotation {
	readonly startLine: number; // zero-based
	readonly raw: string;       // raw matched snippet
}

const parenRe = /^\s*\((lines?)\s+(\d+)(?:\s*([–—-]|to|through|thru)\s*(\d+))?\)/i;

// Parses trailing annotation patterns where line info appears AFTER the file name in prose, or inline parenthesized forms.
export function parseTrailingLineNumberAnnotation(text: string, maxScan = 160): ParsedLineAnnotation | undefined {
	if (!text) { return undefined; }
	const slice = text.slice(0, maxScan);
	const pm = parenRe.exec(slice);
	if (pm) {
		const line = toLine(pm[2]);
		if (line !== undefined) {
			return { startLine: line, raw: pm[0] };
		}
	}
	const tokenRe = /[A-Za-z]+|\d+|[–—-]/g;
	const tokens: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(slice))) {
		tokens.push(m[0]);
		if (tokens.length > 40) { break; }
	}
	for (let i = 0; i < tokens.length; i++) {
		const tk = tokens[i].toLowerCase();
		if (LINE_TOKENS.has(tk)) {
			const numToken = tokens[i + 1];
			if (numToken && /^\d+$/.test(numToken)) {
				const line = toLine(numToken);
				if (line === undefined) { continue; }
				const maybeConnector = tokens[i + 2]?.toLowerCase();
				if (maybeConnector && RANGE_CONNECTORS.has(maybeConnector)) {
					const secondNum = tokens[i + 3];
					const span = (secondNum && /^\d+$/.test(secondNum)) ? 4 : 3;
					return { startLine: line, raw: reconstruct(tokens, i, span) };
				}
				return { startLine: line, raw: reconstruct(tokens, i, 2) };
			}
		}
	}
	return undefined;
}

// Parses preceding annotation patterns where line info appears BEFORE the file name.
// Examples handled (anchor is expected to follow immediately after these tokens):
//   in lines 5-7 of <file>
//   lines 10-12 of <file>
//   on line 45 of <file>
//   at line 7 of <file>
//   ln 22 of <file>
//   at line 19 in <file>
//   line 19 in <file>
// Tokenization would work here too, but a concise end-anchored regex is sufficient
// because we only inspect a short contiguous snapshot directly preceding the file path.
// Returns startLine (zero-based) if matched.
export function parsePrecedingLineNumberAnnotation(text: string): ParsedLineAnnotation | undefined {
	if (!text) { return undefined; }
	// Anchored at end to reduce false positives further back in the snapshot.
	// Accept either 'of' or 'in' as the preposition connecting the line annotation to the file name.
	// This enables patterns like 'at line 19 in file.ts' or 'line 19 in file.ts'.
	const re = /(?:\b(?:in|on|at)\s+)?\b(lines?|ln|l)\b\s+(\d+)(?:\s*(?:-|–|—|to|through|thru)\s*(\d+))?\s+(?:of|in)\s*$/i;
	const m = text.match(re);
	if (!m) { return undefined; }
	const start = toLine(m[2]);
	if (start === undefined) { return undefined; }
	return { startLine: start, raw: m[0] };
}

function toLine(token: string): number | undefined {
	const n = parseInt(token, 10);
	return isNaN(n) || n <= 0 ? undefined : n - 1;
}

function reconstruct(tokens: string[], start: number, span: number): string {
	return tokens.slice(start, start + span).join(' ');
}
