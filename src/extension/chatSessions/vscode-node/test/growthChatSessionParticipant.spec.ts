/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GrowthChatSessionProvider } from '../growthChatSessionProvider';

describe('GrowthChatSessionProvider', () => {
	const store = new DisposableStore();
	let provider: GrowthChatSessionProvider;
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices());
		const accessor = serviceCollection.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		provider = instantiationService.createInstance(GrowthChatSessionProvider);
	});

	afterEach(() => {
		store.clear();
	});

	it('should create a growth chat session provider', () => {
		expect(provider).toBeDefined();
	});

	it('should create handler', () => {
		const handler = provider.createHandler();
		expect(handler).toBeDefined();
		expect(typeof handler).toBe('function');
	});
});
