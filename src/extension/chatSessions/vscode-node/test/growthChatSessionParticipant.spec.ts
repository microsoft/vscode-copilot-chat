/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GrowthChatSessionParticipant } from '../growthChatSessionParticipant';

describe('GrowthChatSessionParticipant', () => {
	const store = new DisposableStore();
	let participant: GrowthChatSessionParticipant;
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices());
		const accessor = serviceCollection.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		participant = instantiationService.createInstance(GrowthChatSessionParticipant);
	});

	afterEach(() => {
		store.clear();
	});

	it('should create a growth chat session participant', () => {
		expect(participant).toBeDefined();
	});

	it('should create handler', () => {
		const handler = participant.createHandler();
		expect(handler).toBeDefined();
		expect(typeof handler).toBe('function');
	});
});
