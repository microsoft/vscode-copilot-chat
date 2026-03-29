/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import { getTextPart } from '../../../../../platform/chat/common/globalStringUtils';
import { TextDocumentSnapshot } from '../../../../../platform/editing/common/textDocumentSnapshot';
import { MockEndpoint } from '../../../../../platform/endpoint/test/node/mockEndpoint';
import { Repository } from '../../../../../platform/git/vscode/git';
import { ILogService } from '../../../../../platform/log/common/logService';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { Range } from '../../../../../vscodeTypes';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { PromptRenderer } from '../../base/promptRenderer';
import { ExplainPrompt } from '../explain';

describe('ExplainPrompt', () => {
	let accessor: ITestingServicesAccessor;

	beforeEach(() => {
		accessor = createExtensionUnitTestingServices().createTestingAccessor();
	});

	test('renders change context for explain-changes flow without falling back to active selection', async () => {
		const documentData = createTextDocumentData(
			URI.file('/workspace/src/example.ts'),
			'const before = 1;\nconst after = 2;\n',
			'typescript'
		);
		const document = TextDocumentSnapshot.create(documentData.document);
		const endpoint = accessor.get(IInstantiationService).createInstance(MockEndpoint, undefined);
		const repository: Partial<Repository> = { rootUri: URI.file('/workspace') };

		const renderer = PromptRenderer.create(accessor.get(IInstantiationService), endpoint, ExplainPrompt, {
			endpoint,
			logService: accessor.get(ILogService),
			changeInput: [{
				document,
				relativeDocumentPath: 'src/example.ts',
				change: {
					repository: repository as Repository,
					uri: document.uri,
					hunks: [{
						range: new Range(1, 0, 2, 0),
						text: '@@ -1,2 +1,2 @@\n-const before = 1;\n+const after = 2;',
					}],
				},
			}],
			promptContext: {
				query: 'Explain the staged changes above.',
				chatVariables: new ChatVariablesCollection([]),
				history: [],
			},
		});

		const result = await renderer.render({ report() { } }, CancellationToken.None);
		const renderedText = result.messages.map(message => getTextPart(message.content)).join('\n');

		expect(renderedText).toContain('<currentChange>');
		expect(renderedText).toContain('From the file: src/example.ts');
		expect(renderedText).toContain('Explain the staged changes above.');
		expect(renderedText).not.toContain('Active selection:');
	});
});
