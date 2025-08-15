/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../platform/test/node/services';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { NuGetMcpSetup } from '../../vscode-node/nuget';
import { FixtureCommandExecutor, FixtureFetcherService } from './util';

describe('get nuget MCP server info using fake CLI', { timeout: 30_000 }, () => {
	let testingServiceCollection: TestingServiceCollection;
	let accessor: ITestingServicesAccessor;
	let logService: ILogService;
	let fetcherService: FixtureFetcherService;
	let commandExecutor: FixtureCommandExecutor;
	let nuget: NuGetMcpSetup;

	beforeEach(() => {
		testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		logService = accessor.get(ILogService);
		fetcherService = new FixtureFetcherService(new Map([
			['https://api.nuget.org/v3/index.json', { fileName: 'nuget-service-index.json', status: 200 }],
			['https://api.nuget.org/v3-flatcontainer/basetestpackage.dotnettool/1.0.0/readme', { fileName: 'nuget-readme.md', status: 200 }],
		]));
		commandExecutor = new FixtureCommandExecutor(new Map([
			['dotnet --version', { stdout: '10.0.100-preview.7.25358.102', exitCode: 0 }]
		]));
		nuget = new NuGetMcpSetup(logService, fetcherService, commandExecutor);
	});

	it('returns package metadata', async () => {
		commandExecutor.fullCommandToResultMap.set(
			'dotnet package search basetestpackage.DOTNETTOOL --source https://api.nuget.org/v3/index.json --prerelease --format json',
			{ fileName: 'dotnet-package-search-exists.json', exitCode: 0 });
		const result = await nuget.getNuGetPackageMetadata('basetestpackage.DOTNETTOOL');
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.name).toBe('BaseTestPackage.DotnetTool');
			expect(result.version).toBe('1.0.0');
			expect(result.publisher).toBe('NuGetTestData');
			await expect(result.readme).toMatchFileSnapshot('fixtures/snapshots/nuget-readme.md');
		} else {
			expect.fail();
		}
	});

	it('handles missing package', async () => {
		commandExecutor.fullCommandToResultMap.set(
			'dotnet package search basetestpackage.dotnettool --source https://api.nuget.org/v3/index.json --prerelease --format json',
			{ fileName: 'dotnet-package-search-does-not-exist.json', exitCode: 0 });
		const result = await nuget.getNuGetPackageMetadata('basetestpackage.dotnettool');
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});
});
