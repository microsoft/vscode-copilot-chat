/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** @jsxRuntime automatic */
/** @jsxImportSource ../../../../prompt/jsx-runtime/ */

import * as assert from 'assert';
import dedent from 'ts-dedent';
import { CancellationTokenSource } from 'vscode-languageserver-protocol';
import { PromptSnapshotNode } from '../../../../prompt/src/components/components';
import { VirtualPrompt } from '../../../../prompt/src/components/virtualPrompt';
import { extractNodesWitPath } from '../../../../prompt/src/test/components/testHelpers';
import { Context } from '../../context';
import { CompletionRequestData } from '../../prompt/completionsPromptFactory/componentsCompletionsPromptFactory';
import { Traits } from '../../prompt/components/traits';
import { TraitWithId } from '../../prompt/contextProviders/contextItemSchemas';
import { TelemetryWithExp } from '../../telemetry';
import { createLibTestingContext } from '../../testing/context';
import { querySnapshot } from '../../testing/snapshot';
import { createTextDocument } from '../../testing/textDocument';

suite('Traits component', function () {
	let ctx: Context;

	const trait1: TraitWithId = {
		name: 'foo',
		value: 'bar',
		importance: 10,
		id: 'traitid1',
		type: 'Trait',
	};
	const trait2: TraitWithId = {
		name: 'baz',
		value: 'qux',
		importance: 5,
		id: 'traitid2',
		type: 'Trait',
	};

	setup(function () {
		ctx = createLibTestingContext();
	});

	test('Renders nothing if there are no traits', async function () {
		try {
			await renderTrait(ctx);
		} catch (e) {
			assert.ok((e as Error).message.startsWith('No children found at path segment '));
		}
	});

	test('Renders nothing if the traits array is empty', async function () {
		try {
			await renderTrait(ctx, []);
		} catch (e) {
			assert.ok((e as Error).message.startsWith('No children found at path segment '));
		}
	});

	test('Renders a single trait', async function () {
		const snapshot = await renderTrait(ctx, [trait1]);
		const traits = querySnapshot(snapshot.snapshot!, 'Traits') as PromptSnapshotNode[];
		assert.deepStrictEqual(traits.length, 2);
		assert.deepStrictEqual(traits[0].children?.[0].value, 'Consider this related information:\n');
		assert.deepStrictEqual(traits[1].props?.source, trait1);
		assert.deepStrictEqual(traits[1].children?.[0].value, 'foo: bar');
	});

	test('Renders multiple traits', async function () {
		const snapshot = await renderTrait(ctx, [trait1, trait2]);
		const result = querySnapshot(snapshot.snapshot!, 'Traits') as PromptSnapshotNode[];

		// Assert that keys are in the path
		assert.deepStrictEqual(extractNodesWitPath(snapshot.snapshot!), [
			'$[0].Traits',
			'$[0].Traits[0].f',
			'$[0].Traits[0].f[0].Text',
			'$[0].Traits[0].f[0].Text[0]',
			'$[0].Traits[0].f["traitid1"].Text',
			'$[0].Traits[0].f["traitid1"].Text[0]',
			'$[0].Traits[0].f["traitid2"].Text',
			'$[0].Traits[0].f["traitid2"].Text[0]',
		]);

		assert.deepStrictEqual(result.length, 3);
		const traits = querySnapshot(snapshot.snapshot!, 'Traits') as PromptSnapshotNode[];
		assert.deepStrictEqual(traits.length, 3);
		assert.deepStrictEqual(traits[0].children?.[0].value, 'Consider this related information:\n');
		assert.deepStrictEqual(traits[1].props?.source, trait1);
		assert.deepStrictEqual(traits[1].children?.[0].value, 'foo: bar');
		assert.deepStrictEqual(traits[2].props?.source, trait2);
		assert.deepStrictEqual(traits[2].children?.[0].value, 'baz: qux');
	});
});

async function renderTrait(ctx: Context, traits?: TraitWithId[]) {
	const document = createTextDocument(
		'file:///foo.ts',
		'typescript',
		0,
		dedent`
		const a = 1;
		function f|
		const b = 2;
	`
	);
	const position = document.positionAt(document.getText().indexOf('|'));

	const virtualPrompt = new VirtualPrompt(<Traits ctx={ctx} />);
	const pipe = virtualPrompt.createPipe();

	const completionRequestData: CompletionRequestData = {
		document,
		position,
		telemetryData: TelemetryWithExp.createEmptyConfigForTesting(),
		cancellationToken: new CancellationTokenSource().token,
		maxPromptTokens: 1000,
		data: undefined,
		traits,
	};

	await pipe.pump(completionRequestData);
	return virtualPrompt.snapshot();
}
