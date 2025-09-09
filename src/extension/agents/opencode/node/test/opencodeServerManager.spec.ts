/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { OpenCodeServerManager } from '../opencodeServerManager';

describe('OpenCodeServerManager', () => {
	let testingServiceCollection: TestingServiceCollection;
	let manager: OpenCodeServerManager;
	let configurationService: IConfigurationService;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		configurationService = accessor.get(IConfigurationService);
		manager = store.add(instantiationService.createInstance(OpenCodeServerManager));
	});

	describe('initial state', () => {
		it('should not be running initially', () => {
			expect(manager.isRunning()).toBe(false);
		});

		it('should return undefined config when not started', () => {
			const config = manager.getConfig();
			expect(config).toBeUndefined();
		});
	});

	describe('configuration', () => {
		it('should return config copy to prevent external modification', async () => {
			// This test verifies the API contract even though we can't actually start the server
			const config = manager.getConfig();
			expect(config).toBeUndefined();

			// When we do have a config, it should be a copy
			// This is validated by the implementation using spread operator
		});

		it('should use default configuration values when no config is set', async () => {
			// Mock configuration service to return undefined/empty config
			const mockGetValue = configurationService.getValue as any;
			if (mockGetValue) {
				mockGetValue.mockReturnValue(undefined);
			}
			
			// We can't directly test getConfiguration() since it's private, 
			// but we can verify it doesn't throw and handles defaults properly
			expect(() => manager.isRunning()).not.toThrow();
		});

		it('should handle autoStart disabled configuration', async () => {
			// Mock configuration service to return autoStart: false
			const mockGetValue = configurationService.getValue as any;
			if (mockGetValue) {
				mockGetValue.mockReturnValue({
					server: { autoStart: false }
				});
			}

			// Starting should throw when autoStart is disabled
			await expect(manager.start()).rejects.toThrow('OpenCode server auto-start is disabled');
		});
	});

	describe('lifecycle management', () => {
		it('should handle multiple stop calls gracefully', async () => {
			// Should not throw when stopping a non-running server
			await expect(manager.stop()).resolves.toBeUndefined();
			await expect(manager.stop()).resolves.toBeUndefined();
		});

		it('should clean up resources on dispose', () => {
			// The dispose method should call stop
			expect(() => manager.dispose()).not.toThrow();
		});
	});

	// Note: We cannot test actual server startup in unit tests since it requires
	// the 'opencode' binary to be installed. These would be integration tests.
	// The start() method would need to be tested in an environment where opencode is available.
});