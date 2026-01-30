/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { JSONTree } from '@vscode/prompt-tsx';
import { beforeAll, describe, expect, test } from 'vitest';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../../vscodeTypes';
import { MockEndpoint } from '../../../../../platform/endpoint/test/node/mockEndpoint';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { renderPromptElement, renderPromptElementJSON } from '../../base/promptRenderer';
import { FileVariable } from '../fileVariable';
import { CopilotToken, createTestExtendedTokenInfo } from '../../../../../platform/authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../../../../platform/authentication/common/copilotTokenStore';

// PromptNodeType enum values from @vscode/prompt-tsx (const enum values are erased at runtime)
const PromptNodeType = {
	Piece: 1,
	Text: 2,
	Opaque: 3
} as const;

function jsonTreeToString(node: JSONTree.PromptNodeJSON): string {
	if (node.type === PromptNodeType.Text) {
		return (node as JSONTree.TextJSON).text;
	} else if (node.type === PromptNodeType.Piece) {
		return (node as JSONTree.PieceJSON).children.map(jsonTreeToString).join('');
	}
	return '';
}

describe('FileVariable', () => {
	let accessor: ITestingServicesAccessor;

	beforeAll(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
	});

	test('does not include unknown untitled file', async () => {
		const result = await renderPromptElementJSON(
			accessor.get(IInstantiationService),
			FileVariable,
			{
				variableName: '',
				variableValue: Uri.parse('untitled:Untitled-1'),
			});
		expect(jsonTreeToString(result.node)).toMatchSnapshot();
	});

	test('does include known untitled file', async () => {
		const untitledUri = Uri.parse('untitled:Untitled-1');
		const untitledDoc = createTextDocumentData(untitledUri, 'test!', 'python').document;

		const testingServiceCollection = createExtensionUnitTestingServices();
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [untitledDoc]));

		accessor = testingServiceCollection.createTestingAccessor();

		const result = await renderPromptElementJSON(
			accessor.get(IInstantiationService),
			FileVariable,
			{
				variableName: '',
				variableValue: Uri.parse('untitled:Untitled-1'),
			});
		expect(jsonTreeToString(result.node)).toMatchSnapshot();
	});

	test('omits file contents when omitContents is true', async () => {
		const untitledUri = Uri.parse('untitled:Untitled-1');
		const untitledDoc = createTextDocumentData(untitledUri, 'file contents that should be omitted', 'python').document;

		const testingServiceCollection = createExtensionUnitTestingServices();
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [untitledDoc]));

		accessor = testingServiceCollection.createTestingAccessor();

		const result = await renderPromptElementJSON(
			accessor.get(IInstantiationService),
			FileVariable,
			{
				variableName: 'myfile',
				variableValue: Uri.parse('untitled:Untitled-1'),
				omitContents: true,
			});
		expect(jsonTreeToString(result.node)).toMatchSnapshot();
	});

	test('uses admin disabled tooltip for image attachments when preview features are disabled', async () => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		const token = new CopilotToken(createTestExtendedTokenInfo({
			token: 'editor_preview_features=0',
			copilot_plan: 'business',
			individual: false,
		}));
		accessor.get(ICopilotTokenStore).copilotToken = token;

		const endpoint = accessor.get(IInstantiationService).createInstance(MockEndpoint, undefined);
		const result = await renderPromptElement(
			accessor.get(IInstantiationService),
			endpoint,
			FileVariable,
			{
				variableName: 'image',
				variableValue: Uri.file('/path/to/image.png'),
			},
			undefined,
			CancellationToken.None,
		);
		expect(result.references[0]?.options?.status?.description).toBe("Vision support is disabled by your admin.");
	});
});
