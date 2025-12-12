/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { TextDocumentSnapshot } from '../../../../../platform/editing/common/textDocumentSnapshot';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../../util/vs/base/common/uri';
import { Position, Range } from '../../../../../vscodeTypes';
import { FileContextElement, FileSelectionElement } from '../inlineChat2Prompt';

function createSnapshot(content: string, languageId: string = 'typescript'): TextDocumentSnapshot {
	const uri = URI.file('/workspace/file.ts');
	const docData = createTextDocumentData(uri, content, languageId);
	return TextDocumentSnapshot.create(docData.document);
}

suite('FileContextElement', () => {

	test('cursor at the beginning of the file', async () => {
		const content = `line 1
line 2
line 3
line 4
line 5`;
		const snapshot = createSnapshot(content);
		const position = new Position(0, 0);

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('$CURSOR$');
		expect(output).toContain('line 1');
		expect(output).toContain('line 2');
		expect(output).toContain('line 3');
	});

	test('cursor in the middle of a file', async () => {
		const content = `line 1
line 2
line 3
line 4
line 5
line 6
line 7`;
		const snapshot = createSnapshot(content);
		const position = new Position(3, 2); // after "li" in "line 4"

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('$CURSOR$');
		// Should include lines before and after cursor
		expect(output).toContain('line 2');
		expect(output).toContain('line 3');
		// Cursor position (3, 2) splits "line 4" into "li" + "$CURSOR$" + "ne 4"
		expect(output).toContain('li$CURSOR$ne 4');
		expect(output).toContain('line 5');
		expect(output).toContain('line 6');
	});

	test('cursor at the end of file', async () => {
		const content = `line 1
line 2
line 3
line 4
line 5`;
		const snapshot = createSnapshot(content);
		const position = new Position(4, 6); // end of "line 5"

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('$CURSOR$');
		expect(output).toContain('line 3');
		expect(output).toContain('line 4');
		expect(output).toContain('line 5');
	});

	test('cursor with empty lines - includes extra lines until non-empty', async () => {
		const content = `

line 3
line 4

`;
		const snapshot = createSnapshot(content);
		const position = new Position(2, 0); // start of "line 3"

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('$CURSOR$');
		expect(output).toContain('line 3');
		expect(output).toContain('line 4');
	});

	test('single line file', async () => {
		const content = `only one line`;
		const snapshot = createSnapshot(content);
		const position = new Position(0, 5); // middle of line

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('only $CURSOR$one line');
	});

	test('cursor position splits text correctly', async () => {
		const content = `hello world`;
		const snapshot = createSnapshot(content);
		const position = new Position(0, 6); // after "hello "

		const element = new FileContextElement({ snapshot, position });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('hello $CURSOR$world');
	});
});

suite('FileSelectionElement', () => {

	test('single line selection', async () => {
		const content = `line 1
line 2
line 3
line 4
line 5`;
		const snapshot = createSnapshot(content);
		const selection = new Range(1, 0, 1, 6); // "line 2"

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('line 2');
		expect(output).not.toContain('line 1');
		expect(output).not.toContain('line 3');
	});

	test('multi-line selection', async () => {
		const content = `line 1
line 2
line 3
line 4
line 5`;
		const snapshot = createSnapshot(content);
		const selection = new Range(1, 0, 3, 6); // "line 2" through "line 4"

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('line 2');
		expect(output).toContain('line 3');
		expect(output).toContain('line 4');
		expect(output).not.toContain('line 1');
		expect(output).not.toContain('line 5');
	});

	test('partial line selection extends to full lines', async () => {
		const content = `line 1
line 2
line 3`;
		const snapshot = createSnapshot(content);
		// Select from middle of line 2 to middle of line 2 (partial)
		const selection = new Range(1, 2, 1, 4);

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		// Should include the full line, not just "ne"
		expect(output).toContain('line 2');
	});

	test('selection at start of file', async () => {
		const content = `line 1
line 2
line 3`;
		const snapshot = createSnapshot(content);
		const selection = new Range(0, 0, 0, 6);

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('line 1');
		expect(output).not.toContain('line 2');
	});

	test('selection at end of file', async () => {
		const content = `line 1
line 2
line 3`;
		const snapshot = createSnapshot(content);
		const selection = new Range(2, 0, 2, 6);

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('line 3');
		expect(output).not.toContain('line 2');
	});

	test('selection spanning partial lines extends to full lines', async () => {
		const content = `first line here
second line here
third line here`;
		const snapshot = createSnapshot(content);
		// Select from middle of "first" to middle of "second"
		const selection = new Range(0, 6, 1, 7);

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		// Should include full lines
		expect(output).toContain('first line here');
		expect(output).toContain('second line here');
		expect(output).not.toContain('third line here');
	});

	test('preserves language id for code block', async () => {
		const content = `const x = 1;`;
		const snapshot = createSnapshot(content, 'javascript');
		const selection = new Range(0, 0, 0, 12);

		const element = new FileSelectionElement({ snapshot, selection });
		const rendered = await element.render(undefined, { tokenBudget: 1000, countTokens: () => Promise.resolve(0), endpoint: {} as any });

		const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
		expect(output).toContain('javascript');
	});
});
