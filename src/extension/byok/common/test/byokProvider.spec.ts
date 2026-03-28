/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { isBYOKEnabled } from '../byokProvider';

function createMockCopilotToken(overrides: { individual?: boolean; organization_list?: string[] } = {}): Omit<CopilotToken, 'token'> {
	return {
		sku: undefined,
		isIndividual: overrides.individual ?? false,
		organizationList: overrides.organization_list ?? [],
		organizationLoginList: [],
		enterpriseList: [],
		endpoints: undefined,
		isInternal: false,
		isMicrosoftInternal: false,
		isGitHubInternal: false,
		isVscodeTeamMember: false,
		username: undefined,
		telemetryId: undefined,
		copilotUserQuotaInfo: undefined,
		modelIds: undefined,
	} as unknown as Omit<CopilotToken, 'token'>;
}

function createMockCAPIClientService(dotcomAPIURL = 'https://api.github.com'): ICAPIClientService {
	return { dotcomAPIURL } as ICAPIClientService;
}

describe('isBYOKEnabled', () => {
	it('should return true for dotcom user when setting is enabled (default)', () => {
		const configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		const token = createMockCopilotToken();
		const capiClient = createMockCAPIClientService();
		expect(isBYOKEnabled(token, capiClient, configService)).toBe(true);
	});

	it('should return true for business/enterprise users on dotcom', () => {
		const configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		const token = createMockCopilotToken({ individual: false, organization_list: ['some-org'] });
		const capiClient = createMockCAPIClientService();
		expect(isBYOKEnabled(token, capiClient, configService)).toBe(true);
	});

	it('should return false for GHE users even when setting is enabled', () => {
		const configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		const token = createMockCopilotToken({ individual: true });
		const capiClient = createMockCAPIClientService('https://ghe.example.com/api/v3');
		expect(isBYOKEnabled(token, capiClient, configService)).toBe(false);
	});

	it('should return false when the BYOKEnabled setting is disabled', () => {
		const configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configService.setConfig(ConfigKey.BYOKEnabled, false);
		const token = createMockCopilotToken({ individual: true });
		const capiClient = createMockCAPIClientService();
		expect(isBYOKEnabled(token, capiClient, configService)).toBe(false);
	});

	it('should return false when BYOKEnabled setting is disabled even for business users', () => {
		const configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configService.setConfig(ConfigKey.BYOKEnabled, false);
		const token = createMockCopilotToken({ individual: false, organization_list: ['some-org'] });
		const capiClient = createMockCAPIClientService();
		expect(isBYOKEnabled(token, capiClient, configService)).toBe(false);
	});
});
