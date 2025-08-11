/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ILogService } from '../../../../platform/log/common/logService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { getNuGetPackageMetadata } from '../../vscode-node/nuget';

describe('get nuget MCP server info', { timeout: 30_000 }, () => {
	const testingServiceCollection = createExtensionUnitTestingServices();
	const accessor = testingServiceCollection.createTestingAccessor();
	const logService = accessor.get(ILogService);

	it('handles missing dotnet', async () => {
		const result = await getNuGetPackageMetadata(
			'NuGet.Mcp.Server',
			logService,
			{ command: 'dotnet-missing', args: [] });
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.errorType).toBe('MissingCommand');
			expect(result.helpUriLabel).toBe('Install .NET SDK');
			expect(result.helpUri).toBe('https://aka.ms/vscode-mcp-install/dotnet');
		} else {
			expect.fail();
		}
	});

	it('handles old dotnet version', async () => {
		const result = await getNuGetPackageMetadata(
			'NuGet.Mcp.Server',
			logService,
			{ command: 'node', args: ['-e', 'console.log("9.0.0")', '--'] });
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.errorType).toBe('BadCommandVersion');
			expect(result.helpUriLabel).toBe('Update .NET SDK');
			expect(result.helpUri).toBe('https://aka.ms/vscode-mcp-install/dotnet');
		} else {
			expect.fail();
		}
	});
});