/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey } from '../../../../../platform/configuration/common/configurationService';
import { getCopilotByokProvider, isCopilotByokMode, isCopilotOfflineMode } from '../copilotCliEnv';
import { createMockConfigService } from './testHelpers';

const BYOK_ENV_KEYS = [
	'COPILOT_PROVIDER_BASE_URL',
	'COPILOT_PROVIDER_TYPE',
	'COPILOT_PROVIDER_WIRE_API',
	'COPILOT_PROVIDER_API_KEY',
	'COPILOT_PROVIDER_BEARER_TOKEN',
	'COPILOT_PROVIDER_MODEL_LIMITS_ID',
	'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
	'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
	'COPILOT_PROVIDER_AZURE_API_VERSION',
	'COPILOT_OFFLINE',
] as const;

describe('copilotCliEnv', () => {
	const savedEnv: Record<string, string | undefined> = {};
	const emptyConfigService = createMockConfigService();

	beforeEach(() => {
		for (const key of BYOK_ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
	});

	afterEach(() => {
		for (const key of BYOK_ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	it('returns false when COPILOT_OFFLINE is unset', () => {
		expect(isCopilotOfflineMode(emptyConfigService)).toBe(false);
	});

	it('returns true when COPILOT_OFFLINE is "true"', () => {
		process.env['COPILOT_OFFLINE'] = 'true';

		expect(isCopilotOfflineMode(emptyConfigService)).toBe(true);
	});

	it('returns false when COPILOT_OFFLINE is "false"', () => {
		process.env['COPILOT_OFFLINE'] = 'false';

		expect(isCopilotOfflineMode(emptyConfigService)).toBe(false);
	});

	describe('getCopilotByokProvider', () => {
		it('returns undefined when COPILOT_PROVIDER_BASE_URL is not set', () => {
			delete process.env['COPILOT_PROVIDER_BASE_URL'];

			expect(getCopilotByokProvider(emptyConfigService)).toBeUndefined();
		});

		it('returns provider config with base URL only', () => {
			process.env['COPILOT_PROVIDER_BASE_URL'] = 'http://localhost:11434/v1';

			const provider = getCopilotByokProvider(emptyConfigService);

			expect(provider).toBeDefined();
			expect(provider!.baseUrl).toBe('http://localhost:11434/v1');
		});

		it('includes all optional provider fields when set', () => {
			process.env['COPILOT_PROVIDER_BASE_URL'] = 'https://my-azure.openai.azure.com';
			process.env['COPILOT_PROVIDER_TYPE'] = 'azure';
			process.env['COPILOT_PROVIDER_WIRE_API'] = 'completions';
			process.env['COPILOT_PROVIDER_API_KEY'] = 'sk-test-key';
			process.env['COPILOT_PROVIDER_BEARER_TOKEN'] = 'bearer-tok';
			process.env['COPILOT_PROVIDER_MODEL_LIMITS_ID'] = 'gpt-4o';
			process.env['COPILOT_PROVIDER_MAX_PROMPT_TOKENS'] = '64000';
			process.env['COPILOT_PROVIDER_MAX_OUTPUT_TOKENS'] = '4096';
			process.env['COPILOT_PROVIDER_AZURE_API_VERSION'] = '2024-02-15-preview';

			const provider = getCopilotByokProvider(emptyConfigService);

			expect(provider).toBeDefined();
			expect(provider!.baseUrl).toBe('https://my-azure.openai.azure.com');
			expect(provider!.type).toBe('azure');
			expect(provider!.wireApi).toBe('completions');
			expect(provider!.apiKey).toBe('sk-test-key');
			expect(provider!.bearerToken).toBe('bearer-tok');
			expect(provider!.modelLimitsId).toBe('gpt-4o');
			expect(provider!.maxPromptTokens).toBe(64000);
			expect(provider!.maxOutputTokens).toBe(4096);
			expect(provider!.azure).toEqual({ apiVersion: '2024-02-15-preview' });
		});

		it('omits azure config when COPILOT_PROVIDER_AZURE_API_VERSION is not set', () => {
			process.env['COPILOT_PROVIDER_BASE_URL'] = 'http://localhost:11434/v1';
			delete process.env['COPILOT_PROVIDER_AZURE_API_VERSION'];

			const provider = getCopilotByokProvider(emptyConfigService);

			expect(provider).toBeDefined();
			expect(provider!.azure).toBeUndefined();
		});
	});

	describe('extension settings override env vars', () => {
		it('isCopilotByokMode returns true when setting is configured', () => {
			delete process.env['COPILOT_PROVIDER_BASE_URL'];
			const configService = createMockConfigService(new Map([[ConfigKey.Advanced.CLIProviderBaseUrl, 'http://localhost:11434/v1']]));

			expect(isCopilotByokMode(configService)).toBe(true);
		});

		it('isCopilotOfflineMode returns true when setting is enabled', () => {
			delete process.env['COPILOT_OFFLINE'];
			const configService = createMockConfigService(new Map([[ConfigKey.Advanced.CLIOffline, true]]));

			expect(isCopilotOfflineMode(configService)).toBe(true);
		});

		it('getCopilotByokProvider uses settings over env vars', () => {
			process.env['COPILOT_PROVIDER_BASE_URL'] = 'http://env-url';
			process.env['COPILOT_PROVIDER_API_KEY'] = 'env-key';
			const configService = createMockConfigService(new Map([
				[ConfigKey.Advanced.CLIProviderBaseUrl, 'http://settings-url'],
				[ConfigKey.Advanced.CLIProviderApiKey, 'settings-key'],
			]));

			const provider = getCopilotByokProvider(configService);

			expect(provider).toBeDefined();
			expect(provider!.baseUrl).toBe('http://settings-url');
			expect(provider!.apiKey).toBe('settings-key');
		});
	});
});