/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AsyncIterUtils } from '../../../../util/common/asyncIterableUtils';
import { XtabCustomDiffPatchResponseHandler } from '../../node/xtabCustomDiffPatchResponseHandler';

describe('XtabCustomDiffPatchResponseHandler', () => {

	async function collectPatches(patchText: string): Promise<string> {
		const linesStream = AsyncIterUtils.fromArray(patchText.split('\n'));
		const patches = await AsyncIterUtils.toArray(XtabCustomDiffPatchResponseHandler.extractEdits(linesStream));
		return patches.map(p => p.toString()).join('\n');
	}

	it('should parse a simple patch correctly', async () => {
		const patchText = `file1.txt:10
-Old line 1
-Old line 2
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('should parse a simple patch correctly', async () => {
		const patchText = `/absolutePath/to/my_file.ts:1
-Old line 1
+New line 1
+New line 2
relative/path/to/another_file.js:42
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('discard a patch if no valid header', async () => {
		const patchText = `myFile.ts:
+New line 1
+New line 2
another_file.js:32
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"another_file.js:32
			-Removed line
			+Added line"
		`);
	});

	it('discard a patch if no valid header - 2', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2
another_file.js:
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no removed lines', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no new lines', async () => {
		const patchText = `myFile.ts:42
-Old line 1
-Old line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			-Old line 1
			-Old line 2"
		`);
	});
});
