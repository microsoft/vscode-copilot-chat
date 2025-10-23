/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load env
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { createTextDocument } from '#lib/test/textDocument';
import { assert, describe, it } from 'vitest';
import { createInlineCompletionsProvider } from '../src/main';

describe('getInlineCompletions', () => {
	it('should return completions for a document and position', async () => {
		const provider = createInlineCompletionsProvider({
			fetcher: undefined as any,
			authService: undefined as any,
			telemetrySender: undefined as any,
			isRunningInTest: true,
			contextProviderMatch: undefined as any,
			statusHandler: undefined as any,
			documentManager: undefined as any,
			workspace: undefined as any,
			urlOpener: undefined as any,
			editorInfo: undefined as any,
			editorPluginInfo: undefined as any,
			relatedPluginInfo: undefined as any,
			editorSession: undefined as any,
			notificationSender: undefined as any,
			endpointProvider: undefined as any,
			capiClientService: undefined as any,
		});
		const doc = createTextDocument('file:///test.txt', 'javascript', 1, 'function main() {\n\n\n}\n');

		const result = await provider.getInlineCompletions(doc, { line: 1, character: 0 });

		assert(result);
	});
});
