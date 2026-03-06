/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { _getParseErrorCount, _dispose } from '../../src/platform/parser/node/parserImpl';
import { getWasmLanguage } from '../../src/platform/parser/node/treeSitterLanguages';
import { XtabCustomDiffPatchResponseHandler } from '../../src/extension/xtab/node/xtabCustomDiffPatchResponseHandler';
import { applyEditsToContent } from './generateResponse';

type CheckStatus = 'pass' | 'fail' | 'skip';

export interface ICheckResult {
	readonly name: string;
	readonly status: CheckStatus;
	readonly message?: string;
}

export interface IValidationResult {
	readonly index: number;
	readonly verdict: 'pass' | 'fail';
	readonly checks: readonly ICheckResult[];
}

export interface IValidationInput {
	readonly index: number;
	readonly languageId: string;
	readonly docContent: string;
	readonly oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[] | undefined;
	readonly assistantResponse: string;
	readonly strategy: string;
}

// Check 1: Tree-sitter syntax regression

async function checkSyntax(
	languageId: string,
	docBefore: string,
	docAfter: string,
): Promise<ICheckResult> {
	const wasmLang = getWasmLanguage(languageId);
	if (!wasmLang) {
		return { name: 'syntax', status: 'skip', message: `Unsupported language: ${languageId}` };
	}

	try {
		const [errorsBefore, errorsAfter] = await Promise.all([
			_getParseErrorCount(wasmLang, docBefore),
			_getParseErrorCount(wasmLang, docAfter),
		]);

		if (errorsAfter > errorsBefore) {
			const introduced = errorsAfter - errorsBefore;
			return {
				name: 'syntax',
				status: 'fail',
				message: `Oracle introduced ${introduced} syntax error${introduced > 1 ? 's' : ''} (${errorsBefore} → ${errorsAfter})`,
			};
		}

		return { name: 'syntax', status: 'pass' };
	} catch (e) {
		return { name: 'syntax', status: 'skip', message: `Parser error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

// Check 2: PatchBased02 format round-trip

async function checkPatchRoundTrip(
	strategy: string,
	assistantResponse: string,
): Promise<ICheckResult> {
	const normalized = strategy.toLowerCase();
	if (!normalized.startsWith('patchbased')) {
		return { name: 'patchRoundTrip', status: 'skip', message: 'Not a PatchBased strategy' };
	}

	try {
		async function* linesStream(lines: string[]) {
			for (const line of lines) {
				yield line;
			}
		}

		const patches: { toString(): string }[] = [];
		for await (const patch of XtabCustomDiffPatchResponseHandler.extractEdits(
			linesStream(assistantResponse.split('\n'))
		)) {
			patches.push(patch);
		}

		if (patches.length === 0) {
			return { name: 'patchRoundTrip', status: 'fail', message: 'Parser extracted 0 patches' };
		}

		// Whitespace-normalized round-trip comparison
		const roundTrip = patches.map(p => p.toString()).join('\n');
		const normalizeWs = (s: string) => s.replace(/[ \t]+$/gm, '').trim();
		if (normalizeWs(roundTrip) !== normalizeWs(assistantResponse)) {
			return { name: 'patchRoundTrip', status: 'fail', message: 'Round-trip mismatch' };
		}

		return { name: 'patchRoundTrip', status: 'pass' };
	} catch (e) {
		return { name: 'patchRoundTrip', status: 'fail', message: `Parser error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

// Check 3: Mid-typing heuristic patterns

/**
 * Find lines added/modified by the oracle edit using frequency subtraction.
 */
function getModifiedLines(docBefore: string, docAfter: string): string[] {
	const beforeLines = docBefore.split('\n');
	const afterLines = docAfter.split('\n');

	const beforeFreq = new Map<string, number>();
	for (const line of beforeLines) {
		beforeFreq.set(line, (beforeFreq.get(line) ?? 0) + 1);
	}

	const modified: string[] = [];
	for (const line of afterLines) {
		const count = beforeFreq.get(line) ?? 0;
		if (count > 0) {
			beforeFreq.set(line, count - 1);
		} else {
			modified.push(line);
		}
	}

	return modified;
}

function isCommentLine(trimmed: string): boolean {
	return trimmed.startsWith('//')
		|| trimmed.startsWith('#')
		|| trimmed.startsWith('*')
		|| trimmed.startsWith('--')
		|| trimmed.startsWith('/*')
		|| trimmed.startsWith('<!--');
}

function checkMidTyping(
	docBefore: string,
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
): ICheckResult {
	const docAfter = applyEditsToContent(docBefore, oracleEdits);
	const modifiedLines = getModifiedLines(docBefore, docAfter);
	const issues: string[] = [];

	for (const line of modifiedLines) {
		const trimmed = line.trim();
		if (!trimmed || isCommentLine(trimmed)) {
			continue;
		}

		// Double operators with whitespace (e.g. `+ +`) but not `++`, `--`
		if (/(?<![+\-*/%=!<>&|^])([+\-*/%]) +\1(?![+\-*/%=!<>&|^])/.test(trimmed)) {
			issues.push(`Double operator: "${trimmed.substring(0, 60)}"`);
		}

		// Line ending with binary operator (excluding `++`, `--`, `=>`, `->`, comparisons)
		if (/[+\-*/%=|&^]\s*$/.test(trimmed)
			&& !/(\+\+|--|=>|->|[><=!]=?=?|&&|\|\|)\s*$/.test(trimmed)
			&& !/^\s*[+\-*/%]/.test(trimmed)) {
			issues.push(`Ends with operator: "${trimmed.substring(0, 60)}"`);
		}

		// Unclosed string literal (odd unescaped quotes, excluding triple-quote markers)
		const singleQuotes = (trimmed.match(/(?<!\\)'/g) ?? []).length;
		const doubleQuotes = (trimmed.match(/(?<!\\)"/g) ?? []).length;
		const backticks = (trimmed.match(/(?<!\\)`/g) ?? []).length;
		if ((singleQuotes % 2 !== 0 && !trimmed.includes('"""') && !trimmed.includes('\'\'\''))
			|| (doubleQuotes % 2 !== 0 && !trimmed.includes('"""') && !trimmed.includes('\'\'\''))) {
			if (backticks % 2 === 0) {
				issues.push(`Unclosed string: "${trimmed.substring(0, 60)}"`);
			}
		}
	}

	// Bracket imbalance ≥2 across all edit texts
	let totalOpenParens = 0;
	let totalCloseParens = 0;
	let totalOpenBrackets = 0;
	let totalCloseBrackets = 0;
	for (const [, , text] of oracleEdits) {
		if (!text) {
			continue;
		}
		totalOpenParens += (text.match(/\(/g) ?? []).length;
		totalCloseParens += (text.match(/\)/g) ?? []).length;
		totalOpenBrackets += (text.match(/\[/g) ?? []).length;
		totalCloseBrackets += (text.match(/\]/g) ?? []).length;
	}
	if (totalOpenParens - totalCloseParens >= 2) {
		issues.push(`Bracket imbalance: ${totalOpenParens} opens vs ${totalCloseParens} closes for ()`);
	}
	if (totalOpenBrackets - totalCloseBrackets >= 2) {
		issues.push(`Bracket imbalance: ${totalOpenBrackets} opens vs ${totalCloseBrackets} closes for []`);
	}

	if (issues.length > 0) {
		return { name: 'midTyping', status: 'fail', message: issues.join('; ') };
	}

	return { name: 'midTyping', status: 'pass' };
}

// Check 4: Oracle edit bounds

function checkEditBounds(
	docContent: string,
	oracleEdits: readonly (readonly [start: number, endEx: number, text: string])[],
): ICheckResult {
	const docLen = docContent.length;

	for (let i = 0; i < oracleEdits.length; i++) {
		const [start, endEx] = oracleEdits[i];
		if (start < 0) {
			return { name: 'editBounds', status: 'fail', message: `Edit ${i}: start (${start}) is negative` };
		}
		if (start > endEx) {
			return { name: 'editBounds', status: 'fail', message: `Edit ${i}: start (${start}) > endEx (${endEx})` };
		}
		if (start > docLen) {
			return { name: 'editBounds', status: 'fail', message: `Edit ${i}: start (${start}) > doc length (${docLen})` };
		}
		if (endEx > docLen) {
			return { name: 'editBounds', status: 'fail', message: `Edit ${i}: endEx (${endEx}) > doc length (${docLen})` };
		}
	}

	// Check if oracle produces empty document
	const docAfter = applyEditsToContent(docContent, oracleEdits);
	if (!docAfter.trim()) {
		return { name: 'editBounds', status: 'fail', message: 'Oracle produces empty document' };
	}

	return { name: 'editBounds', status: 'pass' };
}

export async function validateTrainingSample(input: IValidationInput): Promise<IValidationResult> {
	const checks: ICheckResult[] = [];

	if (!input.oracleEdits || input.oracleEdits.length === 0) {
		checks.push({ name: 'syntax', status: 'skip', message: 'No oracle edits' });
		checks.push(await checkPatchRoundTrip(input.strategy, input.assistantResponse));
		checks.push({ name: 'midTyping', status: 'skip', message: 'No oracle edits' });
		checks.push({ name: 'editBounds', status: 'skip', message: 'No oracle edits' });
	} else {
		const docAfter = applyEditsToContent(input.docContent, input.oracleEdits);

		const [syntaxResult, patchResult] = await Promise.all([
			checkSyntax(input.languageId, input.docContent, docAfter),
			checkPatchRoundTrip(input.strategy, input.assistantResponse),
		]);

		checks.push(syntaxResult);
		checks.push(patchResult);
		checks.push(checkMidTyping(input.docContent, input.oracleEdits));
		checks.push(checkEditBounds(input.docContent, input.oracleEdits));
	}

	const hasFail = checks.some(c => c.status === 'fail');
	return {
		index: input.index,
		verdict: hasFail ? 'fail' : 'pass',
		checks,
	};
}

// ---------------------------------------------------------------------------
export interface IValidationBatchResult {
	readonly results: readonly IValidationResult[];
	readonly passed: number;
	readonly failed: number;
	readonly failReasons: ReadonlyMap<string, number>;
}

/**
 * Validate all training samples sequentially to avoid
 * overwhelming tree-sitter WASM with concurrent parses.
 */
export async function validateAllSamples(
	inputs: readonly IValidationInput[],
): Promise<IValidationBatchResult> {
	const results: IValidationResult[] = [];
	let passed = 0;
	let failed = 0;
	const failReasons = new Map<string, number>();

	for (const input of inputs) {
		const result = await validateTrainingSample(input);
		results.push(result);

		if (result.verdict === 'pass') {
			passed++;
		} else {
			failed++;
			for (const check of result.checks) {
				if (check.status === 'fail') {
					const key = `${check.name}: ${check.message ?? 'unknown'}`;
					failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
				}
			}
		}
	}

	return { results, passed, failed, failReasons };
}

/**
 * Dispose the tree-sitter WASM parser. Call after all validation is done.
 */
export function cleanupValidator(): void {
	_dispose();
}
