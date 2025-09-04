/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeAll, describe, expect, test } from 'vitest';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { renderPromptElementJSON } from '../../base/promptRenderer';
import { FileVariable } from '../fileVariable';

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
		expect(result).toMatchSnapshot();
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
		expect(JSON.stringify(result, undefined, 2)).toMatchSnapshot();
	});
});