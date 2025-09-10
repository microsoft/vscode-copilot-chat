/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { OpenCodeServerManager } from '../opencodeServerManager';

describe('OpenCodeServerManager', () => {
	let testingServiceCollection: TestingServiceCollection;
	let manager: OpenCodeServerManager;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
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

	// Intentionally skip configuration tests for now; configuration is read via
	// getNonExtensionConfig and exercised in higher-level integration.

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
