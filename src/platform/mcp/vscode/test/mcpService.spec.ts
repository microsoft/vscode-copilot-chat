/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TestLogService } from '../../../testing/common/testLogService';

const { mockStartMcpGateway } = vi.hoisted(() => ({
	mockStartMcpGateway: vi.fn(),
}));

vi.mock('vscode', () => ({
	lm: {
		get mcpServerDefinitions() { return []; },
		get onDidChangeMcpServerDefinitions() { return () => ({ dispose() { } }); },
		startMcpGateway: mockStartMcpGateway,
	},
}));

// Import after mock so the module picks up the mocked vscode
import { McpService } from '../mcpServiceImpl';

function createMockGateway() {
	return {
		address: { toString: () => 'http://localhost:1234' },
		dispose: vi.fn(),
	};
}

describe('McpService', () => {
	let service: McpService;
	let logService: TestLogService;

	beforeEach(() => {
		logService = new TestLogService();
		service = new McpService(logService);
		mockStartMcpGateway.mockReset();
	});

	afterEach(() => {
		service.dispose();
	});

	test('startMcpGateway creates and returns a tracked gateway', async () => {
		const mockGateway = createMockGateway();
		mockStartMcpGateway.mockResolvedValue(mockGateway);

		const result = await service.startMcpGateway('session-1');

		expect(result).toBeDefined();
		expect(result!.address).toBe(mockGateway.address);
		expect(mockStartMcpGateway).toHaveBeenCalledOnce();
	});

	test('startMcpGateway returns existing gateway for same sessionId', async () => {
		const mockGateway = createMockGateway();
		mockStartMcpGateway.mockResolvedValue(mockGateway);

		const first = await service.startMcpGateway('session-1');
		const second = await service.startMcpGateway('session-1');

		expect(first).toBe(second);
		expect(mockStartMcpGateway).toHaveBeenCalledOnce();
	});

	test('startMcpGateway creates separate gateways for different sessionIds', async () => {
		const gateway1 = createMockGateway();
		const gateway2 = createMockGateway();
		mockStartMcpGateway.mockResolvedValueOnce(gateway1).mockResolvedValueOnce(gateway2);

		const first = await service.startMcpGateway('session-1');
		const second = await service.startMcpGateway('session-2');

		expect(first).not.toBe(second);
		expect(mockStartMcpGateway).toHaveBeenCalledTimes(2);
	});

	test('startMcpGateway returns undefined when lm returns undefined', async () => {
		mockStartMcpGateway.mockResolvedValue(undefined);

		const result = await service.startMcpGateway('session-1');

		expect(result).toBeUndefined();
	});

	test('startMcpGateway returns undefined and logs warning on error', async () => {
		const warnSpy = vi.spyOn(logService, 'warn');
		mockStartMcpGateway.mockRejectedValue(new Error('gateway failed'));

		const result = await service.startMcpGateway('session-1');

		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gateway failed'));
	});

	test('disposing a gateway removes it from tracking', async () => {
		const mockGateway = createMockGateway();
		mockStartMcpGateway.mockResolvedValue(mockGateway);

		const tracked = await service.startMcpGateway('session-1');
		tracked!.dispose();

		expect(mockGateway.dispose).toHaveBeenCalledOnce();

		// Next call should create a new gateway since the old one was removed
		const newMockGateway = createMockGateway();
		mockStartMcpGateway.mockResolvedValue(newMockGateway);
		const second = await service.startMcpGateway('session-1');

		expect(second).not.toBe(tracked);
		expect(mockStartMcpGateway).toHaveBeenCalledTimes(2);
	});

	test('disposing the service disposes all tracked gateways', async () => {
		const gateway1 = createMockGateway();
		const gateway2 = createMockGateway();
		mockStartMcpGateway.mockResolvedValueOnce(gateway1).mockResolvedValueOnce(gateway2);

		await service.startMcpGateway('session-1');
		await service.startMcpGateway('session-2');

		service.dispose();

		expect(gateway1.dispose).toHaveBeenCalledOnce();
		expect(gateway2.dispose).toHaveBeenCalledOnce();
	});

	test('service dispose does not double-dispose individually disposed gateways', async () => {
		const gateway1 = createMockGateway();
		const gateway2 = createMockGateway();
		mockStartMcpGateway.mockResolvedValueOnce(gateway1).mockResolvedValueOnce(gateway2);

		const tracked1 = await service.startMcpGateway('session-1');
		await service.startMcpGateway('session-2');

		// Dispose session-1 individually
		tracked1!.dispose();
		expect(gateway1.dispose).toHaveBeenCalledOnce();

		// Dispose the service - should only dispose session-2
		service.dispose();
		expect(gateway1.dispose).toHaveBeenCalledOnce();
		expect(gateway2.dispose).toHaveBeenCalledOnce();
	});
});
