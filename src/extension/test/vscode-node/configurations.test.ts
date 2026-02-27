/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { Config, ConfigKey } from '../../../platform/configuration/common/configurationService';
import { ConfigurationServiceImpl } from '../../../platform/configuration/vscode/configurationServiceImpl';
import { Event } from '../../../util/vs/base/common/event';
import { NullEnvService } from '../../../platform/env/common/nullEnvService';

suite('Configuration Defaults', () => {

	let testObject: ConfigurationServiceImpl;

	setup(() => {
		testObject = new ConfigurationServiceImpl({
			_serviceBrand: undefined,
			copilotToken: undefined,
			onDidStoreUpdate: Event.None
		}, new NullEnvService());
	});

	teardown(() => testObject.dispose());

	test('default values of all advanced settings should match default values', () => {
		const advancedSettings = Object.values(ConfigKey.Advanced) as Config<unknown>[];

		for (const setting of advancedSettings) {
			const actual = testObject.getConfig<unknown>(setting);
			const expected = testObject.getDefaultValue(setting);
			assert.strictEqual(actual, expected, `Default value for ${setting.fullyQualifiedId} did not match`);
		}

	});

	test('default values of all internal settings', () => {
		const internalSettings = Object.values(ConfigKey.TeamInternal) as Config<unknown>[];

		for (const setting of internalSettings) {
			const actual = testObject.getConfig<unknown>(setting);
			const expected = testObject.getDefaultValue(setting);
			assert.strictEqual(actual, expected, `Default value for ${setting.fullyQualifiedId} did not match`);
		}
	});

});