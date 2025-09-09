/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { OpenCodeClient, IOpenCodeClient } from '../opencodeClient';

describe('OpenCodeClient', () => {
	let testingServiceCollection: TestingServiceCollection;
	let client: IOpenCodeClient;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		client = store.add(instantiationService.createInstance(OpenCodeClient));
	});

	describe('initial state', () => {
		it('should require configuration before making requests', async () => {
			await expect(client.getAllSessions()).rejects.toThrow('OpenCodeClient not configured');
		});

		it('should accept configuration', () => {
			const config = {
				url: 'http://localhost:3000',
				port: 3000,
				hostname: 'localhost'
			};

			expect(() => client.setConfig(config)).not.toThrow();
		});
	});

	describe('WebSocket functionality', () => {
		beforeEach(() => {
			// Set up client configuration
			client.setConfig({
				url: 'http://localhost:3000',
				port: 3000,
				hostname: 'localhost'
			});
		});

		it('should expose WebSocket event emitters', () => {
			expect(client.onSessionUpdated).toBeDefined();
			expect(client.onMessageReceived).toBeDefined();
			expect(client.onSessionCreated).toBeDefined();
			expect(client.onSessionDeleted).toBeDefined();
		});

		it('should handle WebSocket connection attempts', async () => {
			// Since we're using a placeholder implementation for WebSocket,
			// we verify that the methods exist and handle calls gracefully
			expect(typeof client.connectWebSocket).toBe('function');
			expect(typeof client.disconnectWebSocket).toBe('function');
			
			// Should not throw for placeholder implementation
			await expect(client.connectWebSocket()).resolves.toBeUndefined();
			await expect(client.disconnectWebSocket()).resolves.toBeUndefined();
		});

		it('should clean up WebSocket on dispose', () => {
			// Ensure dispose doesn't throw
			expect(() => client.dispose()).not.toThrow();
		});
	});

	describe('session management', () => {
		beforeEach(() => {
			client.setConfig({
				url: 'http://localhost:3000',
				port: 3000,
				hostname: 'localhost'
			});
		});

		it('should provide session management methods', () => {
			expect(typeof client.getAllSessions).toBe('function');
			expect(typeof client.getSession).toBe('function');
			expect(typeof client.createSession).toBe('function');
			expect(typeof client.sendMessage).toBe('function');
			expect(typeof client.deleteSession).toBe('function');
		});

		// Note: Actual HTTP requests would be tested in integration tests
		// where we can mock the HTTP server responses
	});
});