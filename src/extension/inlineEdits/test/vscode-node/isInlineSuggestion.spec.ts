/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { Position, Range, Uri } from 'vscode';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { isInlineSuggestion } from '../../vscode-node/isInlineSuggestion';

suite('isInlineSuggestion', () => {

	function createMockDocument(lines: string[], languageId: string = 'typescript') {
		return createTextDocumentData(Uri.from({ scheme: 'test', path: '/test/file.ts' }), lines.join('\n'), languageId).document;
	}

	function getBaseCompletionScenario() {
		const document = createMockDocument(['This is line 1,', 'This is line,', 'This is line 3,']);
		const replaceRange = new Range(1, 0, 1, 13);
		const completionInsertionPoint = new Position(1, 12);
		const replaceText = 'This is line 2,';
		return { document, completionInsertionPoint, replaceRange, replaceText };
	}

	test('isInlineSuggestion line before completion', () => {
		const { document, completionInsertionPoint, replaceRange, replaceText } = getBaseCompletionScenario();

		const cursorPosition = new Position(completionInsertionPoint.line - 1, completionInsertionPoint.character);

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	test('isInlineSuggestion same line before completion', () => {
		const { document, completionInsertionPoint, replaceRange, replaceText } = getBaseCompletionScenario();

		const cursorPosition = new Position(completionInsertionPoint.line, completionInsertionPoint.character - 1);

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), true);
	});

	test('isInlineSuggestion same line at completion', () => {
		const { document, completionInsertionPoint, replaceRange, replaceText } = getBaseCompletionScenario();

		const cursorPosition = new Position(completionInsertionPoint.line, completionInsertionPoint.character);

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), true);
	});

	test('isInlineSuggestion same line after completion', () => {
		const { document, completionInsertionPoint, replaceRange, replaceText } = getBaseCompletionScenario();

		const cursorPosition = new Position(completionInsertionPoint.line, completionInsertionPoint.character + 1);

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	test('isInlineSuggestion line after completion', () => {
		const { document, completionInsertionPoint, replaceRange, replaceText } = getBaseCompletionScenario();

		const cursorPosition = new Position(completionInsertionPoint.line + 1, completionInsertionPoint.character);

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	test('isInlineSuggestion multi-line replace range', () => {
		const document = createMockDocument(['This is line 1,', 'This is line,', 'This is line,']);
		const replaceRange = new Range(1, 0, 2, 13);
		const replaceText = 'This is line 2,\nThis is line 3,';

		const cursorPosition = replaceRange.start;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	test('isInlineSuggestion multi-line insertion', () => {
		const document = createMockDocument(['This is line 1,', 'This is line,', 'This is line 5,']);
		const replaceRange = new Range(1, 12, 1, 13);
		const replaceText = ' 2,\nThis is line 3,\nThis is line 4,';

		const cursorPosition = replaceRange.start;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), true);
	});

	test('isInlineSuggestion multi-line insertion on next line', () => {
		const document = createMockDocument(['This is line 1,', 'This is line 2,', 'This is line 5,']);
		const cursorRange = new Range(1, 15, 1, 15);
		const replaceRange = new Range(2, 0, 2, 0);
		const replaceText = 'This is line 3,\nThis is line 4,\n';

		const cursorPosition = cursorRange.start;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), true);
	});

	test('isInlineSuggestion should not use ghost text when inserting on next line when none empty', () => {
		const document = createMockDocument(['This is line 1,', 'This is line 2,', 'line 3,']);
		const cursorRange = new Range(1, 15, 1, 15);
		const replaceRange = new Range(2, 0, 2, 0);
		const replaceText = 'This is ';

		const cursorPosition = cursorRange.start;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	// Even though this would be a nice way to render the suggestion, ghost text view on the core side
	// is not able to render such suggestions
	test('isInlineSuggestion should not use ghost text when inserting on existing line below', () => {
		const document = createMockDocument(['This is line 1,', 'This is line 2,', '', 'This is line 4,']);
		const cursorRange = new Range(1, 15, 1, 15);
		const replaceRange = new Range(2, 0, 2, 0);
		const replaceText = 'This is line 3,';

		const cursorPosition = cursorRange.start;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), false);
	});

	test('render ghost text for next line suggestion', () => {

		const document = createMockDocument([`import * as vscode from 'vscode';
import { NodeTypesIndex } from './nodeTypesIndex';
import { Result } from './util/common/result';

export class NodeTypesOutlineProvider implements vscode.DocumentSymbolProvider {

	/**
	 * @remark This works only for valid tree-sitter \`node-types.json\` files.
	 */
	provideDocumentSymbols(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.SymbolInformation[] | vscode.DocumentSymbol[]> {

		const nodeTypesIndex = new NodeTypesIndex(document);

		const astNodes = nodeTypesIndex.nodes;

		if (Result.isErr(astNodes)) {
			throw astNodes.err;
		}

		const symbols: vscode.DocumentSymbol[] = astNodes.val.map(astNode => {
			const range = new vscode.Range(
				document.positionAt(astNode.offset),
				document.positionAt(astNode.offset + astNode.length)
			);

			const revealRange = new vscode.Range(
				document.positionAt(astNode.type.offset),
				document.positionAt(astNode.type.offset + astNode.type.length)
			);

			return new vscode.DocumentSymbol(
				astNode.type.value,
				astNode.named.value ? 'Named' : 'Anonymous',
				vscode.SymbolKind.Object,
				range,
				revealRange,
			);
		});

		return symbols;
	}
}
function createDocumentSymbol(
`]);
		const cursorPosition = new Position(45, 30);
		const replaceRange = new Range(46, 0, 46, 0);
		const replaceText = `	astNode: { type: { value: string; offset: number; length: number }; named: { value: boolean }; offset: number; length: number },
	document: vscode.TextDocument
): vscode.DocumentSymbol {
	const range = new vscode.Range(
		document.positionAt(astNode.offset),
		document.positionAt(astNode.offset + astNode.length)
	);

	const revealRange = new vscode.Range(
		document.positionAt(astNode.type.offset),
		document.positionAt(astNode.type.offset + astNode.type.length)
	);

	return new vscode.DocumentSymbol(
		astNode.type.value,
		astNode.named.value ? 'Named' : 'Anonymous',
		vscode.SymbolKind.Object,
		range,
		revealRange,
	);
}`;

		assert.strictEqual(isInlineSuggestion(cursorPosition, document, replaceRange, replaceText), true);
	});
});
