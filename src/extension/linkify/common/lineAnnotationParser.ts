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

export function parseLineNumberAnnotation(text: string, maxScan = 160): ParsedLineAnnotation | undefined {
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

function toLine(token: string): number | undefined {
	const n = parseInt(token, 10);
	return isNaN(n) || n <= 0 ? undefined : n - 1;
}

function reconstruct(tokens: string[], start: number, span: number): string {
	return tokens.slice(start, start + span).join(' ');
}
