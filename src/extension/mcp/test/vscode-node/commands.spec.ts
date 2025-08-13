/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ILogService } from '../../../../platform/log/common/logService';
import { FetchOptions, IAbortController, IFetcherService, Response } from '../../../../platform/networking/common/fetcherService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../platform/test/node/services';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { McpSetupCommands } from '../../vscode-node/commands';

describe('get MCP server info', { timeout: 30_000 }, () => {
	let testingServiceCollection: TestingServiceCollection;
	let accessor: ITestingServicesAccessor;
	let logService: ILogService;
	let emptyFetcherService: FixtureFetcherService;

	beforeEach(() => {
		testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		logService = accessor.get(ILogService);
		emptyFetcherService = new FixtureFetcherService(404);
	});

	it('npm returns package metadata', async () => {
		const fetcherService = new FixtureFetcherService(200, 'npm-modelcontextprotocol-server-everything.json');
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'npm', name: '@modelcontextprotocol/server-everything' }, logService, fetcherService);
		expect(fetcherService.lastUrl).toBe('https://registry.npmjs.org/%40modelcontextprotocol%2Fserver-everything');
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
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'npm', name: '@modelcontextprotocol/does-not-exist' }, logService, emptyFetcherService);
		expect(emptyFetcherService.lastUrl).toBe('https://registry.npmjs.org/%40modelcontextprotocol%2Fdoes-not-exist');
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});

	it('pip returns package metadata', async () => {
		const fetcherService = new FixtureFetcherService(200, 'pip-mcp-server-fetch.json');
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'pip', name: 'mcp-server-fetch' }, logService, fetcherService);
		expect(fetcherService.lastUrl).toBe('https://pypi.org/pypi/mcp-server-fetch/json');
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
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'pip', name: 'mcp-server-that-does-not-exist' }, logService, emptyFetcherService);
		expect(emptyFetcherService.lastUrl).toBe('https://pypi.org/pypi/mcp-server-that-does-not-exist/json');
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});

	it('docker returns package metadata', async () => {
		const fetcherService = new FixtureFetcherService(200, 'docker-mcp-node-code-sandbox.json');
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'docker', name: 'mcp/node-code-sandbox' }, logService, fetcherService);
		expect(fetcherService.lastUrl).toBe('https://hub.docker.com/v2/repositories/mcp/node-code-sandbox');
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
		const result = await McpSetupCommands.validatePackageRegistry({ type: 'docker', name: 'mcp/server-that-does-not-exist' }, logService, emptyFetcherService);
		expect(emptyFetcherService.lastUrl).toBe('https://hub.docker.com/v2/repositories/mcp/server-that-does-not-exist');
		expect(result.state).toBe('error');
		if (result.state === 'error') {
			expect(result.error).toBeDefined();
			expect(result.errorType).toBe('NotFound');
		} else {
			expect.fail();
		}
	});
});

class FixtureFetcherService implements IFetcherService {
	lastUrl?: string;

	constructor(readonly status: number = 404, readonly fileName?: string) { }

	fetch(url: string, options: FetchOptions): Promise<Response> {
		this.lastUrl = url;
		// Simulate a successful response
		return Promise.resolve({
			ok: this.status === 200,
			status: this.status,
			json: async () => {
				if (this.fileName) {
					const filePath = path.join(__dirname, 'fixtures', 'snapshots', this.fileName);
					return JSON.parse(await fs.readFile(filePath, 'utf-8'));
				} else {
					return {};
				}
			},
		} as Response);
	}

	_serviceBrand: undefined;
	getUserAgentLibrary(): string { throw new Error('Method not implemented.'); }
	disconnectAll(): Promise<unknown> { throw new Error('Method not implemented.'); }
	makeAbortController(): IAbortController { throw new Error('Method not implemented.'); }
	isAbortError(e: any): boolean { throw new Error('Method not implemented.'); }
	isInternetDisconnectedError(e: any): boolean { throw new Error('Method not implemented.'); }
	isFetcherError(e: any): boolean { throw new Error('Method not implemented.'); }
	getUserMessageForFetcherError(err: any): string { throw new Error('Method not implemented.'); }
}
