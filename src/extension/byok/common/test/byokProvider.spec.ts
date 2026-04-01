/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CopilotToken, createTestExtendedTokenInfo } from '../../../../platform/authentication/common/copilotToken';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { isBYOKEnabled } from '../byokProvider';

function createToken(overrides: { individual?: boolean; organization_list?: string[]; token?: string }): Omit<CopilotToken, 'token'> {
	return new CopilotToken(createTestExtendedTokenInfo({
		individual: overrides.individual ?? false,
		organization_list: overrides.organization_list ?? [],
		token: overrides.token ?? 'test-token',
	}));
}

const dotcomCAPI = { dotcomAPIURL: 'https://api.github.com' } as ICAPIClientService;
const gheCAPI = { dotcomAPIURL: 'https://ghe.example.com/api/v3' } as ICAPIClientService;

describe('isBYOKEnabled', () => {
	it('returns true for individual users on dotcom', () => {
		const token = createToken({ individual: true });
		expect(isBYOKEnabled(token, dotcomCAPI)).toBe(true);
	});

	it('returns false for individual users on GHE', () => {
		const token = createToken({ individual: true });
		expect(isBYOKEnabled(token, gheCAPI)).toBe(false);
	});

	it('returns false for business users without client_byok policy', () => {
		const token = createToken({ individual: false });
		expect(isBYOKEnabled(token, dotcomCAPI)).toBe(false);
	});

	it('returns true for business users with client_byok=1 policy', () => {
		const token = createToken({ individual: false, token: 'client_byok=1' });
		expect(isBYOKEnabled(token, dotcomCAPI)).toBe(true);
	});

	it('returns false for business users with client_byok=0 policy', () => {
		const token = createToken({ individual: false, token: 'client_byok=0' });
		expect(isBYOKEnabled(token, dotcomCAPI)).toBe(false);
	});

	it('returns false for business users with client_byok=1 on GHE', () => {
		const token = createToken({ individual: false, token: 'client_byok=1' });
		expect(isBYOKEnabled(token, gheCAPI)).toBe(false);
	});
});
