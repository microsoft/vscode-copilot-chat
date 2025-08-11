/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ILogService } from '../../../../platform/log/common/logService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { McpSetupCommands } from '../../vscode-node/commands';

describe('get MCP server info', { timeout: 30_000 }, () => {
	const testingServiceCollection = createExtensionUnitTestingServices();
	const accessor = testingServiceCollection.createTestingAccessor();
	const logService = accessor.get(ILogService);

	it('npm returns package metadata', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'npm', name: '@modelcontextprotocol/server-everything' }, logService);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.name).toBe('@modelcontextprotocol/server-everything');
			expect(result.version).toBeDefined();
			expect(result.publisher).toContain('jspahrsummers');
		} else {
			expect.fail();
		}
	});

	it('npm handles missing package', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'npm', name: '@modelcontextprotocol/does-not-exist' }, logService);
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});

	it('pip returns package metadata', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'pip', name: 'mcp-server-fetch' }, logService);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.name).toBe('mcp-server-fetch');
			expect(result.version).toBeDefined();
			expect(result.publisher).toContain('Anthropic');
		} else {
			expect.fail();
		}
	});

	it('pip handles missing package', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'pip', name: 'mcp-server-that-does-not-exist' }, logService);
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});

	it('nuget returns server.json', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'nuget', name: 'NuGet.Mcp.Server' }, logService);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.getServerManifest).toBeDefined();
			if (result.getServerManifest) {
				const serverManifest = await result.getServerManifest(Promise.resolve());
				expect(serverManifest).toBeDefined();
				expect(serverManifest.packages).toBeDefined();
				expect(serverManifest.packages.length).toBeGreaterThan(0);
			} else {
				expect.fail();
			}
		} else {
			expect.fail();
		}
	});

	it('nuget returns package metadata', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'nuget', name: 'basetestpackage.dotnettool' }, logService);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.name).toBe('BaseTestPackage.DotnetTool');
			expect(result.version).toBe('1.0.0');
			expect(result.publisher).toContain('NuGetTestData');
		} else {
			expect.fail();
		}
	});

	it('nuget handles missing package', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'nuget', name: 'BaseTestPackage.DoesNotExist' }, logService);
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});

	it('docker returns package metadata', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'docker', name: 'mcp/node-code-sandbox' }, logService);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.name).toBe('mcp/node-code-sandbox');
			expect(result.version).toBeUndefined(); // currently not populated
			expect(result.publisher).toBe("mcp");
		} else {
			expect.fail();
		}
	});

	it('docker handles missing package', async () => {
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'docker', name: 'mcp/server-that-does-not-exist' }, logService);
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});
});
