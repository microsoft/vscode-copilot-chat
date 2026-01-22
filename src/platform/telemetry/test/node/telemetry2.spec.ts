/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotToken, createTestExtendedTokenInfo } from '../../../authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../../authentication/common/copilotTokenStore';
import { createPlatformServices } from '../../../test/node/services';
import { TelemetryUserConfigImpl } from '../../common/telemetry';

suite('Telemetry unit tests', function () {
	test('Can create telemetry user config with values', async function () {
		const accessor = createPlatformServices().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		const config = instantiationService.createInstance(TelemetryUserConfigImpl, 'trackingId', true);

		assert.strictEqual(config.trackingId, 'trackingId');
		assert.ok(config.optedIn);
	});

	test('Telemetry user config has undefined tracking id', async function () {
		const accessor = createPlatformServices().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const config = instantiationService.createInstance(TelemetryUserConfigImpl, undefined, undefined);

		assert.strictEqual(config.trackingId, undefined);
	});

	test('Telemetry user config uses trackingId', async function () {
		const accessor = createPlatformServices().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const config = instantiationService.createInstance(TelemetryUserConfigImpl, 'trackingId', undefined);

		assert.strictEqual(config.trackingId, 'trackingId');
	});

	test('Telemetry user config updates on token change', async function () {
		const accessor = createPlatformServices().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const config = instantiationService.createInstance(TelemetryUserConfigImpl, undefined, undefined);
		const copilotToken = new CopilotToken(createTestExtendedTokenInfo({
			token: 'tid=0123456789abcdef0123456789abcdef;rt=1;ssc=0;dom=org1.com;ol=org1,org2',
			organization_list: ['org1', 'org2'],
			username: 'fake',
			copilot_plan: 'unknown',
		}));

		accessor.get(ICopilotTokenStore).copilotToken = copilotToken;

		assert.strictEqual(config.trackingId, '0123456789abcdef0123456789abcdef');
		assert.strictEqual(config.organizationsList, 'org1,org2');
		assert.ok(config.optedIn);
	});

	test('Telemetry user config updates on token change and opts out', async function () {
		const accessor = createPlatformServices().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const config = instantiationService.createInstance(TelemetryUserConfigImpl, undefined, undefined);
		const copilotToken = new CopilotToken(createTestExtendedTokenInfo({
			token: 'tid=0123456789abcdef0123456789abcdef;rt=0;ssc=0;dom=org1.com;ol=org1,org2',
			username: 'fake',
			copilot_plan: 'unknown'
		}));

		accessor.get(ICopilotTokenStore).copilotToken = copilotToken;

		assert.ok(!config.optedIn);
	});
});
