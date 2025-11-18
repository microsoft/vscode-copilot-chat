/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { AbstractConfigurationService } from '../../common/configurationService';

suite('AbstractConfigurationService', () => {
	suite('_extractHashValue', () => {
		test('should return a value between 0 and 1', () => {
			const value = AbstractConfigurationService._extractHashValue('test');
			assert.strictEqual(typeof value, 'number');
			assert.ok(value >= 0 && value <= 1, `Value ${value} should be between 0 and 1`);
		});

		test('should return the same value for the same input', () => {
			const input = 'github.copilot.advanced.testSetting;user1';
			const value1 = AbstractConfigurationService._extractHashValue(input);
			const value2 = AbstractConfigurationService._extractHashValue(input);
			assert.strictEqual(value1, value2);
		});

		test('should return different values for different inputs', () => {
			const value1 = AbstractConfigurationService._extractHashValue('setting1;user1');
			const value2 = AbstractConfigurationService._extractHashValue('setting2;user1');
			assert.notStrictEqual(value1, value2);
		});

		test('should handle empty string', () => {
			const value = AbstractConfigurationService._extractHashValue('');
			assert.strictEqual(typeof value, 'number');
			assert.ok(value >= 0 && value <= 1);
		});

		test('should produce different values when username changes', () => {
			const setting = 'github.copilot.advanced.testSetting';
			const value1 = AbstractConfigurationService._extractHashValue(`${setting};user1`);
			const value2 = AbstractConfigurationService._extractHashValue(`${setting};user2`);
			assert.notStrictEqual(value1, value2);
		});

		test('should be deterministic for complex strings', () => {
			const input = 'github.copilot.advanced.someComplexSetting;username123!@#$%^&*()';
			const expected = AbstractConfigurationService._extractHashValue(input);

			// Call multiple times to ensure determinism
			for (let i = 0; i < 5; i++) {
				const actual = AbstractConfigurationService._extractHashValue(input);
				assert.strictEqual(actual, expected);
			}
		});
	});
});