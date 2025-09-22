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
import { MarkdownString } from '../../../../util/vs/base/common/htmlContent';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { FindTextInFilesTool } from '../findTextInFilesTool';

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

		const searchService = new TestSearchService(patterns);
		collection.define(ISearchService, searchService);
		accessor = collection.createTestingAccessor();
		return searchService;
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

	test('retries with plain text when regex yields no results', async () => {
		const searchService = setup('*.ts');

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: '(?:hello)', includePattern: '*.ts' }, toolInvocationToken: null!, }, CancellationToken.None);

		expect(searchService.calls.map(call => call.isRegExp)).toEqual([true, false]);
		expect(searchService.calls.every(call => call.pattern === '(?:hello)')).toBe(true);
	});

	test('does not retry when text pattern is invalid regex', async () => {
		const searchService = setup('*.ts');

		const tool = accessor.get(IInstantiationService).createInstance(FindTextInFilesTool);
		await tool.invoke({ input: { query: '[', includePattern: '*.ts', isRegexp: false }, toolInvocationToken: null!, }, CancellationToken.None);

		expect(searchService.calls.map(call => call.isRegExp)).toEqual([false]);
	});
});

interface IRecordedSearchCall {
	readonly pattern: string;
	readonly isRegExp: boolean | undefined;
}

class TestSearchService extends AbstractSearchService {

	public readonly arr1: string[] = [];
	public arr2: readonly string[] = [];

	constructor(private readonly expectedIncludePattern: readonly vscode.GlobPattern[]) {
		super();
	}

	private readonly recordedCalls: IRecordedSearchCall[] = [];

	public get calls(): readonly IRecordedSearchCall[] {
		return this.recordedCalls;
	}

	override async findTextInFiles(query: vscode.TextSearchQuery, options: vscode.FindTextInFilesOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<vscode.TextSearchComplete> {
		throw new Error('Method not implemented.');
	}

	override findTextInFiles2(query: vscode.TextSearchQuery2, options?: vscode.FindTextInFilesOptions2, token?: vscode.CancellationToken): vscode.FindTextInFilesResponse {
		expect(options?.include).toEqual(this.expectedIncludePattern);
		this.recordedCalls.push({
			pattern: query.pattern,
			isRegExp: query.isRegExp,
		});
		return {
			complete: Promise.resolve({}),
			results: (async function* () { })()
		};
	}

	override async findFiles(filePattern: vscode.GlobPattern, options?: vscode.FindFiles2Options | undefined, token?: vscode.CancellationToken | undefined): Promise<vscode.Uri[]> {
		throw new Error('Method not implemented.');
	}
}