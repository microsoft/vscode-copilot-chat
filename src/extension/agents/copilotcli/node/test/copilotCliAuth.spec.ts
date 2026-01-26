/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../../platform/log/common/logService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { CopilotCLISDK } from '../copilotCli';

describe('CopilotCLISDK Authentication', () => {
	const disposables = new DisposableStore();
	let instantiationService: IInstantiationService;
	let configurationService: IConfigurationService;
	let authService: IAuthenticationService;
	let logService: ILogService;

	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		instantiationService = services.seal();
		configurationService = accessor.get(IConfigurationService);
		authService = accessor.get(IAuthenticationService);
		logService = accessor.get(ILogService);
	});

	afterEach(() => {
		disposables.clear();
	});

	it('should skip token validation when proxy URL is configured', async () => {
		// Mock configuration to return a proxy URL
		const mockConfigService = new class extends mock<IConfigurationService>() {
			override getConfig(key: any) {
				if (key === ConfigKey.Shared.DebugOverrideProxyUrl) {
					return 'https://proxy.example.com';
				}
				return undefined;
			}
		};

		const mockAuthService = new class extends mock<IAuthenticationService>() {
			override async getGitHubSession() {
				// This should not be called when proxy is configured
				throw new Error('getGitHubSession should not be called when proxy is configured');
			}
		};

		const mockExtensionContext = new class extends mock<IVSCodeExtensionContext>() {
			override workspaceState = {
				get: () => ({}),
				update: async () => { }
			};
		};

		const mockEnvService = new class extends mock<IEnvService>() { };

		const sdk = new CopilotCLISDK(
			mockExtensionContext,
			mockEnvService,
			logService,
			instantiationService,
			mockAuthService,
			mockConfigService
		);

		const authInfo = await sdk.getAuthInfo();

		expect(authInfo.type).toBe('token');
		expect(authInfo.token).toBe('');
		expect(authInfo.host).toBe('https://github.com');
	});

	it('should skip token validation when CAPI URL is configured', async () => {
		// Mock configuration to return a CAPI URL
		const mockConfigService = new class extends mock<IConfigurationService>() {
			override getConfig(key: any) {
				if (key === ConfigKey.Shared.DebugOverrideCAPIUrl) {
					return 'https://capi.example.com';
				}
				return undefined;
			}
		};

		const mockAuthService = new class extends mock<IAuthenticationService>() {
			override async getGitHubSession() {
				// This should not be called when CAPI URL is configured
				throw new Error('getGitHubSession should not be called when CAPI URL is configured');
			}
		};

		const mockExtensionContext = new class extends mock<IVSCodeExtensionContext>() {
			override workspaceState = {
				get: () => ({}),
				update: async () => { }
			};
		};

		const mockEnvService = new class extends mock<IEnvService>() { };

		const sdk = new CopilotCLISDK(
			mockExtensionContext,
			mockEnvService,
			logService,
			instantiationService,
			mockAuthService,
			mockConfigService
		);

		const authInfo = await sdk.getAuthInfo();

		expect(authInfo.type).toBe('token');
		expect(authInfo.token).toBe('');
		expect(authInfo.host).toBe('https://github.com');
	});

	it('should call getGitHubSession when no proxy URLs are configured', async () => {
		let getGitHubSessionCalled = false;

		// Mock configuration to return no proxy URLs
		const mockConfigService = new class extends mock<IConfigurationService>() {
			override getConfig() {
				return undefined;
			}
		};

		const mockAuthService = new class extends mock<IAuthenticationService>() {
			override async getGitHubSession() {
				getGitHubSessionCalled = true;
				return {
					accessToken: 'test-token',
					id: 'test-id',
					scopes: [],
					account: { id: 'test-account', label: 'Test User' }
				};
			}
		};

		const mockExtensionContext = new class extends mock<IVSCodeExtensionContext>() {
			override workspaceState = {
				get: () => ({}),
				update: async () => { }
			};
		};

		const mockEnvService = new class extends mock<IEnvService>() { };

		const sdk = new CopilotCLISDK(
			mockExtensionContext,
			mockEnvService,
			logService,
			instantiationService,
			mockAuthService,
			mockConfigService
		);

		const authInfo = await sdk.getAuthInfo();

		expect(getGitHubSessionCalled).toBe(true);
		expect(authInfo.type).toBe('token');
		expect(authInfo.token).toBe('test-token');
		expect(authInfo.host).toBe('https://github.com');
	});

	it('should return empty token when getGitHubSession returns undefined and no proxy is configured', async () => {
		// Mock configuration to return no proxy URLs
		const mockConfigService = new class extends mock<IConfigurationService>() {
			override getConfig() {
				return undefined;
			}
		};

		const mockAuthService = new class extends mock<IAuthenticationService>() {
			override async getGitHubSession() {
				return undefined;
			}
		};

		const mockExtensionContext = new class extends mock<IVSCodeExtensionContext>() {
			override workspaceState = {
				get: () => ({}),
				update: async () => { }
			};
		};

		const mockEnvService = new class extends mock<IEnvService>() { };

		const sdk = new CopilotCLISDK(
			mockExtensionContext,
			mockEnvService,
			logService,
			instantiationService,
			mockAuthService,
			mockConfigService
		);

		const authInfo = await sdk.getAuthInfo();

		expect(authInfo.type).toBe('token');
		expect(authInfo.token).toBe('');
		expect(authInfo.host).toBe('https://github.com');
	});
});
