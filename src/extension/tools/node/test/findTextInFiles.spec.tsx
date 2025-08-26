/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, suite, test } from 'vitest';
import type * as vscode from 'vscode';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { AbstractSearchService, ISearchService } from '../../../../platform/search/common/searchService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { FindTextInFilesTool } from '../findTextInFilesTool';
import { MarkdownString } from '../../../../util/vs/base/common/htmlContent';

suite('FindTextInFiles', () => {
	let accessor: ITestingServicesAccessor;
	let collection: TestingServiceCollection;

	const workspaceFolder = isWindows ? 'c:\\test\\workspace' : '/test/workspace';

	beforeEach(() => {
		collection = createExtensionUnitTestingServices();
		collection.define(IWorkspaceService, new SyncDescriptor(TestWorkspaceService, [[URI.file(workspaceFolder)]]));
	});

	afterEach(() => {
		accessor.dispose();
	});

	function setup(expected: vscode.GlobPattern) {
		const patterns: vscode.GlobPattern[] = [expected];
		if (typeof expected === 'string' && !expected.endsWith('/**')) {
			patterns.push(expected + '/**');
		} else if (typeof expected !== 'string' && !expected.pattern.endsWith('/**')) {
			patterns.push(new RelativePattern(expected.baseUri, expected.pattern + '/**'));
		}

		collection.define(ISearchService, new TestSearchService(patterns));
		accessor = collection.createTestingAccessor();
	}

	test('passes through simple query', async () => {
		setup('*.ts');

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: 'hello', includePattern: '*.ts' }, toolInvocationToken: null!, }, CancellationToken.None);
	});

	test('using **/ correctly', async () => {
		setup('src/**');

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: 'hello', includePattern: 'src/**' }, toolInvocationToken: null!, }, CancellationToken.None);
	});

	test('handles absolute path with glob', async () => {
		setup(new RelativePattern(URI.file(workspaceFolder), 'test/**/*.ts'));

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: 'hello', includePattern: `${workspaceFolder}/test/**/*.ts` }, toolInvocationToken: null!, }, CancellationToken.None);
	});

	test('handles absolute path to folder', async () => {
		setup(new RelativePattern(URI.file(workspaceFolder), ''));

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: 'hello', includePattern: workspaceFolder }, toolInvocationToken: null!, }, CancellationToken.None);
	});

	test('escapes backtick', async () => {
		setup(new RelativePattern(URI.file(workspaceFolder), ''));

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		const prepared = await tool.prepareInvocation({ input: { query: 'hello `world`' }, }, CancellationToken.None);
		expect((prepared?.invocationMessage as any as MarkdownString).value).toMatchInlineSnapshot(`"Searching text for \`\` hello \`world\` \`\`"`);
	});
});

class TestSearchService extends AbstractSearchService {
	constructor(private readonly expectedIncludePattern: vscode.GlobPattern[]) {
		super();
	}

	override async findTextInFiles(query: vscode.TextSearchQuery, options: vscode.FindTextInFilesOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<vscode.TextSearchComplete> {
		throw new Error('Method not implemented.');
	}

	override findTextInFiles2(query: vscode.TextSearchQuery2, options?: vscode.FindTextInFilesOptions2, token?: vscode.CancellationToken): vscode.FindTextInFilesResponse {
		expect(options?.include).toEqual(this.expectedIncludePattern);
		return {
			complete: Promise.resolve({}),
			results: (async function* () { })()
		};
	}

	override async findFiles(filePattern: vscode.GlobPattern, options?: vscode.FindFiles2Options | undefined, token?: vscode.CancellationToken | undefined): Promise<vscode.Uri[]> {
		throw new Error('Method not implemented.');
	}
}