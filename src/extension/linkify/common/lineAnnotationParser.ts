/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// General, extensible parser for line annotations following a file path.
// Keeps logic maintainable by avoiding a monolithic fragile regex.

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
					if (!secondNum || !/^\d+$/.test(secondNum)) {
						return { startLine: line, raw: reconstruct(tokens, i, 4) };
					}
					return { startLine: line, raw: reconstruct(tokens, i, 4) };
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

if (typeof process !== 'undefined' && process.env?.VITEST_INTERNAL_EVAL === 'lineAnnotationParserDev') {
	const samples = [
		'(line 42)',
		'(lines 10-15)',
		'is located at lines 77–85.',
		'is found at lines 5-9',
		'is at lines 6 through 11',
		'on line 120',
		'at line 33',
		'lines 44-50',
		'Ln 22',
		'line 9'
	];
	for (const s of samples) {
		console.log('ANNOT_SAMPLE', s, parseLineNumberAnnotation(s));
	}
}
