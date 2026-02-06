/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AsyncIterUtils } from '../../../../util/common/asyncIterableUtils';
import { streamToLines } from '../../node/streamTransformer';

describe('streamToLines', () => {
	async function run(chunks: string[]) {
		const streamOfChunks = AsyncIterUtils.fromArray(chunks);

		const linesStream = streamToLines(streamOfChunks);

		return JSON.stringify(await AsyncIterUtils.toArray(linesStream), null, 2);
	}
	it('handles trailing line', async () => {
		expect(await run(['hello\n'])).toMatchInlineSnapshot(`
			"[
			  "hello",
			  ""
			]"
		`);
	});
});
