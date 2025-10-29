/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import dedent from 'ts-dedent';
import {
	DEFAULT_MAX_COMPLETION_LENGTH,
	DEFAULT_MAX_PROMPT_LENGTH,
	DEFAULT_NUM_SNIPPETS,
	DEFAULT_PROMPT_ALLOCATION_PERCENT,
	DEFAULT_SUFFIX_MATCH_THRESHOLD,
	PromptOptions,
} from '../../../../prompt/src/prompt';
import { defaultSimilarFilesOptions } from '../../../../prompt/src/snippetInclusion/similarFiles';
import { CopilotContentExclusionManager } from '../../contentExclusion/contentExclusionManager';
import { ICompletionsContextService } from '../../context';
import { ExpTreatmentVariables } from '../../experiments/expConfig';
import { TelemetryWithExp } from '../../telemetry';
import { createLibTestingContext } from '../../test/context';
import { createTextDocument, InMemoryNotebookDocument, TestTextDocumentManager } from '../../test/textDocument';
import { INotebookCell, IPosition } from '../../textDocument';
import { TextDocumentManager } from '../../textDocumentManager';
import { CompletionsPromptRenderer } from '../components/completionsPromptRenderer';
import { _copilotContentExclusion, _promptError, getPromptOptions } from '../prompt';
import { extractPromptInternal } from './prompt';

suite('Prompt unit tests', function () {
	let ctx: ICompletionsContextService;
	let sandbox: sinon.SinonSandbox;

	setup(function () {
		sandbox = sinon.createSandbox();
		ctx = createLibTestingContext();
	});

	teardown(function () {
		sandbox.restore();
	});

	test('defaults to 8K max prompt length', async function () {
		const content = 'function add()\n';
		const sourceDoc = createTextDocument('file:///foo.js', 'javascript', 0, content);
		const cursorPosition: IPosition = {
			line: 0,
			character: 13,
		};

		const rendererStub = sandbox.stub(CompletionsPromptRenderer.prototype, 'render').throws('unspecified error');

		const prompt = await extractPromptInternal(
			ctx,
			'COMPLETION_ID',
			sourceDoc,
			cursorPosition,
			TelemetryWithExp.createEmptyConfigForTesting()
		);

		assert.deepStrictEqual(prompt, _promptError);
		assert.ok(rendererStub.calledOnce, 'should call renderer');
		assert.strictEqual(
			rendererStub.firstCall.args[1].promptTokenLimit,
			8192 - DEFAULT_MAX_COMPLETION_LENGTH,
			'should default to 8192 max total tokens, 7692 max prompt tokens'
		);
	});

	test('default EXP prompt options are the same as default PromptOptions object', function () {
		const promptOptionsFromExp = getPromptOptions(ctx, TelemetryWithExp.createEmptyConfigForTesting(), '');
		const defaultPromptOptions: PromptOptions = {
			maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
			numberOfSnippets: DEFAULT_NUM_SNIPPETS,
			similarFilesOptions: defaultSimilarFilesOptions,
			suffixMatchThreshold: DEFAULT_SUFFIX_MATCH_THRESHOLD,
			suffixPercent: DEFAULT_PROMPT_ALLOCATION_PERCENT.suffix,
		};

		assert.deepStrictEqual(promptOptionsFromExp, defaultPromptOptions);
	});

	test('default C++ EXP prompt options use tuned values', function () {
		const promptOptionsFromExp: PromptOptions = getPromptOptions(
			ctx,
			TelemetryWithExp.createEmptyConfigForTesting(),
			'cpp'
		);

		assert.deepStrictEqual(promptOptionsFromExp.similarFilesOptions, {
			snippetLength: 60,
			threshold: 0.0,
			maxTopSnippets: 16,
			maxCharPerFile: 100000,
			maxNumberOfFiles: 200,
			maxSnippetsPerFile: 4,
			useSubsetMatching: false,
		});
		assert.deepStrictEqual(promptOptionsFromExp.numberOfSnippets, 16);
	});

	test('default Java EXP prompt options are correct', function () {
		const telemetryWithExp = TelemetryWithExp.createEmptyConfigForTesting();
		const expVars = telemetryWithExp.filtersAndExp.exp.variables;

		Object.assign(expVars, {
			[ExpTreatmentVariables.UseSubsetMatching]: true,
		});

		const promptOptionsFromExp = getPromptOptions(ctx, telemetryWithExp, 'java');
		assert.deepStrictEqual(promptOptionsFromExp.similarFilesOptions, {
			snippetLength: 60,
			threshold: 0.0,
			maxTopSnippets: 4,
			maxCharPerFile: 10000,
			maxNumberOfFiles: 20,
			maxSnippetsPerFile: 1,
			useSubsetMatching: true,
		});
		assert.deepStrictEqual(promptOptionsFromExp.numberOfSnippets, 4);
	});

	test('should return without a prompt if the file blocked by repository control', async function () {
		const evaluateStub = sandbox.stub(CopilotContentExclusionManager.prototype, 'evaluate');
		evaluateStub.callsFake(_ => {
			return Promise.resolve({ isBlocked: true });
		});

		const content = 'function add()\n';
		const sourceDoc = createTextDocument('file:///foo.js', 'javascript', 0, content);
		const cursorPosition: IPosition = {
			line: 0,
			character: 13,
		};
		const response = await extractPromptInternal(
			ctx,
			'COMPLETION_ID',
			sourceDoc,
			cursorPosition,
			TelemetryWithExp.createEmptyConfigForTesting()
		);
		assert.ok(response);
		assert.strictEqual(response, _copilotContentExclusion);
	});

	test('prompt for ipython notebooks, using only the current cell language as shebang', async function () {
		await assertPromptForCell(
			ctx,
			cells[4],
			dedent(
				`import math

def add(a, b):
    return a + b

def product(c, d):`
			),
			['#!/usr/bin/env python3']
		);
	});

	test('prompt for ipython notebooks, using only the current cell language for known language', async function () {
		await assertPromptForCell(
			ctx,
			cells[5],
			dedent(
				`def product(c, d):`
			),
			['Language: julia']
		);
	});

	test('prompt for ipython notebooks, using only the current cell language for unknown language', async function () {
		await assertPromptForCell(ctx, cells[6], dedent(`foo bar baz`), ['Language: unknown-great-language']);
	});

	test('exception telemetry', async function () {
		this.skip();
		/* todo@dbaeumer need to understand how we handle exception in chat
		class TestExceptionTextDocumentManager extends TestTextDocumentManager {
			override textDocuments() {
				return Promise.reject(new Error('test error'));
			}
		}
		const tdm = ctx.instantiationService.createInstance(TestExceptionTextDocumentManager);
		tdm.setTextDocument('file:///a/1.py', 'python', 'import torch');
		ctx.forceSet(TextDocumentManager, tdm);
		NeighborSource.reset();

		const { reporter, enhancedReporter } = await withInMemoryTelemetry(ctx, async ctx => {
			const document = createTextDocument('file:///a/2.py', 'python', 0, 'import torch');
			await extractPromptInternal(
				ctx,
				'COMPLETION_ID',
				document,
				{ line: 0, character: 0 },
				TelemetryWithExp.createEmptyConfigForTesting()
			);
		});

		assert.ok(reporter.hasException);
		assert.deepStrictEqual(
			reporter.firstException?.properties?.origin,
			'PromptComponents.CompletionsPromptFactory'
		);
		assert.strictEqual(reporter.exceptions.length, 1);

		assert.ok(enhancedReporter.hasException);
		assert.deepStrictEqual(
			enhancedReporter.firstException?.properties?.origin,
			'PromptComponents.CompletionsPromptFactory'
		);
		assert.strictEqual(enhancedReporter.exceptions.length, 1);
		*/
	});
});

async function assertPromptForCell(ctx: ICompletionsContextService, sourceCell: INotebookCell, expectedPrefix: string, expectedContext?: string[]) {
	const notebook = new InMemoryNotebookDocument(cells);
	const sourceDoc = sourceCell.document;

	(ctx.get(TextDocumentManager) as TestTextDocumentManager).setNotebookDocument(sourceDoc, notebook);

	const cursorPosition: IPosition = {
		line: 0,
		character: sourceDoc.getText().length,
	};
	const response = await extractPromptInternal(
		ctx,
		'COMPLETION_ID',
		sourceDoc,
		cursorPosition,
		TelemetryWithExp.createEmptyConfigForTesting()
	);
	assert.ok(response);
	assert.strictEqual(response.type, 'prompt');
	assert.strictEqual(response.prompt.prefix, expectedPrefix);
	if (expectedContext !== undefined) {
		assert.deepEqual(response.prompt.context, expectedContext);
	}
}

const cells: INotebookCell[] = [
	{
		index: 1,
		document: createTextDocument('file:///test/a.ipynb#1', 'python', 1, 'import math'),
		metadata: {},
		kind: 2,
	},
	{
		index: 2,
		document: createTextDocument(
			'file:///test/a.ipynb#2',
			'markdown',
			1,
			'This is an addition function\nIt is used to add two numbers'
		),
		metadata: {},
		kind: 1,
	},
	{
		index: 3,
		document: createTextDocument('file:///test/a.ipynb#3', 'python', 2, 'def add(a, b):\n    return a + b'),
		metadata: {},
		kind: 2,
	},
	{
		index: 4,
		document: createTextDocument(
			'file:///test/a.ipynb#4',
			'markdown',
			2,
			'This is a product function\nYou guessed it: it multiplies two numbers'
		),
		metadata: {},
		kind: 2,
	},
	{
		index: 5,
		document: createTextDocument('file:///test/a.ipynb#5', 'python', 3, 'def product(c, d):'),
		metadata: {},
		kind: 2,
	},
	{
		index: 6,
		document: createTextDocument('file:///test/a.ipynb#6', 'julia', 3, 'def product(c, d):'),
		metadata: {},
		kind: 2,
	},
	{
		index: 7,
		document: createTextDocument('file:///test/a.ipynb#7', 'unknown-great-language', 3, 'foo bar baz'),
		metadata: {},
		kind: 2,
	},
];
