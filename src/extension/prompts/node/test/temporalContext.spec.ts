/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { assert, beforeEach, expect, suite, test } from 'vitest';
import type { TextDocument } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { IHeatmapService, SelectionPoint } from '../../../../platform/heatmap/common/heatmapService';
import { createPlatformServices } from '../../../../platform/test/node/services';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { summarizeTemporalContext } from '../inline/temporalContext';
import { fixture, loadFile, RelativeFilePath } from './utils';

suite('summarizeTemporalContext', () => {

	let instaService: IInstantiationService;
	let configService: IConfigurationService;

	let entries: Map<TextDocument, SelectionPoint[]>;
	let sampleDocCodeEditorWidget: TextDocument;
	let sampleDocCurrent: TextDocumentSnapshot;

	/**
	 * Creates a sample TextDocument from a given relative file path.
	 * @param p - The relative file path.
	 * @returns A promise that resolves to a TextDocument.
	 */
	async function makeSampleDoc(p: RelativeFilePath<'$dir/fixtures'>, languageId: string = 'typescript'): Promise<TextDocument> {
		const file = await loadFile({ filePath: fixture(p), languageId });
		return createTextDocumentData(URI.file(file.filePath), file.contents, file.languageId).document;
	}

	beforeEach(async () => {
		const services = createPlatformServices();
		services.define(IHeatmapService, new class implements IHeatmapService {
			_serviceBrand: undefined;
			async getEntries(): Promise<Map<TextDocument, SelectionPoint[]>> {
				return entries ?? new Map();
			}
		});

		const testingAccessor = services.createTestingAccessor();
		instaService = testingAccessor.get(IInstantiationService);
		configService = testingAccessor.get(IConfigurationService);

		// sample files
		sampleDocCodeEditorWidget = await makeSampleDoc('codeEditorWidget.ts');
		sampleDocCurrent = TextDocumentSnapshot.create(createTextDocumentData(URI.parse('fake:///file/path/app.ts'), '', 'typescript').document);
	});

	test('no documents when not entries exist', async () => {

		const result = await instaService.invokeFunction(summarizeTemporalContext, 100, [sampleDocCurrent]);
		assert.strictEqual(result.size, 0);
	});

	test('no documents when filtered', async () => {

		entries = new Map([
			[sampleDocCodeEditorWidget, [new SelectionPoint(6749, Date.now())]]
		]);

		const result = await instaService.invokeFunction(
			summarizeTemporalContext,
			Number.MAX_SAFE_INTEGER,
			[TextDocumentSnapshot.create(sampleDocCodeEditorWidget)]
		);

		assert.strictEqual(result.size, 0);
	});


	test('selections, offsets make it', async () => {

		entries = new Map([
			[sampleDocCodeEditorWidget, [new SelectionPoint(6749, Date.now())]]
		]);

		const result = await instaService.invokeFunction(
			summarizeTemporalContext,
			8192,
			[sampleDocCurrent]
		);
		assert.strictEqual(result.size, 1);

		const { projectedDoc: doc } = result.get(sampleDocCodeEditorWidget.uri.toString())!;
		assert.ok(doc);

		await expect(doc?.text).toMatchFileSnapshot(sampleDocCodeEditorWidget.uri.fsPath + '.1.tempo-summarized');
	});

	test('selections, offsets make it', async () => {

		const docActions = await makeSampleDoc('tempo-actions.ts');
		const docChatActions = await makeSampleDoc('tempo-chatActions.ts');
		const docChatContextActions = await makeSampleDoc('tempo-chatContextActions.ts');

		entries = new Map([
			[docActions, [new SelectionPoint(15335, Date.now() - 50)]],
			[docChatActions, [new SelectionPoint(4398, Date.now() - 10)]],
			[docChatContextActions, [new SelectionPoint(4677, Date.now() - 100), new SelectionPoint(5715, 28)]],
		]);

		const result = await instaService.invokeFunction(
			summarizeTemporalContext,
			8192,
			[sampleDocCurrent]
		);
		assert.strictEqual(result.size, 3);


		await expect(result.get(docActions.uri.toString())?.projectedDoc?.text).toMatchFileSnapshot(docActions.uri.fsPath + '.2.tempo-summarized');
		await expect(result.get(docChatActions.uri.toString())?.projectedDoc?.text).toMatchFileSnapshot(docChatActions.uri.fsPath + '.2.tempo-summarized');
		await expect(result.get(docChatContextActions.uri.toString())?.projectedDoc?.text).toMatchFileSnapshot(docChatContextActions.uri.fsPath + '.2.tempo-summarized');
	});


	test('prefer same lang', async () => {

		configService.setConfig(ConfigKey.Internal.TemporalContextPreferSameLang as any, true);

		const docActions = await makeSampleDoc('tempo-actions.ts');
		const docActions2 = await makeSampleDoc('tempo-actions.html', 'html');

		entries = new Map([
			[docActions, [new SelectionPoint(15335, Date.now() - 50)]],
			[docActions2, [new SelectionPoint(15335, Date.now() - 50)]],
		]);

		const result = await instaService.invokeFunction(
			summarizeTemporalContext,
			8192,
			[sampleDocCurrent]
		);
		assert.strictEqual(result.size, 2);


		await expect(result.get(docActions.uri.toString())?.projectedDoc?.text).toMatchFileSnapshot(docActions.uri.fsPath + '.3.tempo-summarized');
		await expect(result.get(docActions2.uri.toString())?.projectedDoc?.text).toMatchFileSnapshot(docActions2.uri.fsPath + '.3.tempo-summarized');

		configService.setConfig(ConfigKey.Internal.TemporalContextPreferSameLang as any, false);
	});


});
