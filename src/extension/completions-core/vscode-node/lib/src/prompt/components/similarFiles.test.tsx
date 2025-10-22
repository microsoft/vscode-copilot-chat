/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** @jsxRuntime automatic */
/** @jsxImportSource ../../../../prompt/jsx-runtime/ */

import * as assert from 'assert';
import dedent from 'ts-dedent';
import { PromptSnapshotNode } from '../../../../prompt/src/components/components';
import { VirtualPrompt } from '../../../../prompt/src/components/virtualPrompt';
import { initializeTokenizers } from '../../../../prompt/src/tokenization';
import { Context } from '../../context';
import { CompletionRequestDocument } from '../../prompt/completionsPromptFactory/componentsCompletionsPromptFactory';
import { SimilarFiles } from '../../prompt/components/similarFiles';
import { CodeSnippetWithId, TraitWithId } from '../../prompt/contextProviders/contextItemSchemas';
import { NeighborSource } from '../../prompt/similarFiles/neighborFiles';
import { RelatedFilesProvider, RelatedFileTrait } from '../../prompt/similarFiles/relatedFiles';
import { MockTraitsProvider } from '../../prompt/testing/relatedFiles';
import { createCompletionRequestData } from '../../testing/completionsPrompt';
import { createLibTestingContext } from '../../testing/context';
import { querySnapshot } from '../../testing/snapshot';
import { createTextDocument, TestTextDocumentManager } from '../../testing/textDocument';
import { TextDocumentManager } from '../../textDocumentManager';

suite('Similar Files', function () {
	let ctx: Context;

	setup(async function () {
		ctx = createLibTestingContext();
		NeighborSource.reset();
		await initializeTokenizers;
	});

	test('Empty render without similar file', async function () {
		const doc = document('untitled:', 'typescript', 'const a = 23;');

		const snapshot = await createSnapshot(ctx, doc, []);

		const snapshotNode = querySnapshot(snapshot, 'SimilarFiles') as PromptSnapshotNode[];
		assert.deepStrictEqual(snapshotNode, []);
	});

	test('Renders single similar file', async function () {
		const doc = document('file:///foo.ts', 'typescript', '//sum\nconst result = |');
		const similarFile = document(
			'file:///calculator.ts',
			'typescript',
			'export function sum(a: number, b: number) { return a + b; }'
		);

		const snapshot = await createSnapshot(ctx, doc, [similarFile]);

		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[0].SimilarFile.Chunk[0].Text'),
			'Compare this snippet from calculator.ts:'
		);
		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[0].SimilarFile.Chunk[1].Text'),
			'export function sum(a: number, b: number) { return a + b; }'
		);
	});

	test('Renders multiple similar files', async function () {
		const doc = document('file:///foo.ts', 'typescript', '//sum and multiply\nconst result = |');
		const similar1 = document(
			'file:///sum.ts',
			'typescript',
			'export function sum(a: number, b: number) { return a + b; }'
		);
		const similar2 = document(
			'file:///multiply.ts',
			'typescript',
			'export function multiply(a: number, b: number) { return a * b; }'
		);

		const snapshot = await createSnapshot(ctx, doc, [similar1, similar2]);

		const similarFileNodes = querySnapshot(snapshot, 'SimilarFiles') as PromptSnapshotNode[];
		assert.deepStrictEqual(similarFileNodes.length, 2);
		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[0].SimilarFile.Chunk[0].Text'),
			'Compare this snippet from sum.ts:'
		);
		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[0].SimilarFile.Chunk[1].Text'),
			'export function sum(a: number, b: number) { return a + b; }'
		);
		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[1].SimilarFile.Chunk[0].Text'),
			'Compare this snippet from multiply.ts:'
		);
		assert.deepStrictEqual(
			querySnapshot(snapshot, 'SimilarFiles.f[1].SimilarFile.Chunk[1].Text'),
			'export function multiply(a: number, b: number) { return a * b; }'
		);
	});

	test('Similar files can be turned off', async function () {
		const doc = document('file:///foo.ts', 'typescript', '//sum\nconst result = |');
		const similarFile = document(
			'file:///calculator.ts',
			'typescript',
			'export function sum(a: number, b: number) { return a + b; }'
		);

		const snapshot = await createSnapshot(ctx, doc, [similarFile], undefined, undefined, true);

		const similarFiles = querySnapshot(snapshot, 'SimilarFiles') as PromptSnapshotNode[];
		assert.deepStrictEqual(similarFiles, []);
	});

	async function createSnapshot(
		ctx: Context,
		doc: CompletionRequestDocument,
		neighbors: CompletionRequestDocument[],
		codeSnippets?: CodeSnippetWithId[],
		traits?: TraitWithId[],
		turnOffSimilarFiles?: boolean,
		legacyTraits?: RelatedFileTrait[]
	) {
		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		neighbors.forEach(n => tdm.setTextDocument(n.uri, n.detectedLanguageId, n.getText()));
		const position = doc.positionAt(doc.getText().indexOf('|'));

		if (legacyTraits !== undefined) {
			// For legacy traits to work we need to:
			// - set the document in the text document manager
			// - initialize workspace folders
			tdm.init([{ uri: 'file:///workspace' }]);
			tdm.setTextDocument(doc.uri, doc.detectedLanguageId, doc.getText());
			ctx.forceSet(RelatedFilesProvider, new MockTraitsProvider(ctx, legacyTraits));
		}

		const virtualPrompt = new VirtualPrompt(<SimilarFiles ctx={ctx} />);
		const pipe = virtualPrompt.createPipe();
		await pipe.pump(createCompletionRequestData(ctx, doc, position, codeSnippets, traits, turnOffSimilarFiles));
		return virtualPrompt.snapshot().snapshot!;
	}

	function document(uri: string, languageId: string, text: string) {
		return createTextDocument(uri, languageId, 0, dedent`${text}`);
	}
});
