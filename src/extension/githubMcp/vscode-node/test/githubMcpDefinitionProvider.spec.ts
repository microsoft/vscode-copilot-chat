/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GITHUB_SCOPE_ALIGNED } from '../../../../platform/authentication/common/authentication';
import { AuthProviderId, ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { TestingServiceCollection } from '../../../../platform/test/node/services';
import { raceTimeout } from '../../../../util/vs/base/common/async';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { GitHubMcpDefinitionProvider } from '../githubMcpDefinitionProvider';

describe('GitHubMcpDefinitionProvider', () => {
	let disposables: DisposableStore;
	let provider: GitHubMcpDefinitionProvider;
	let configService: InMemoryConfigurationService;

	/**
	 * Helper to create a provider with specific configuration values.
	 */
	async function createProvider(configOverrides?: {
		authProvider?: AuthProviderId;
		gheUri?: string;
		toolsets?: string[];
	}): Promise<GitHubMcpDefinitionProvider> {
		const serviceCollection = new TestingServiceCollection();
		configService = disposables.add(new InMemoryConfigurationService(new DefaultsOnlyConfigurationService()));

		// Set configuration values before creating the provider
		if (configOverrides?.authProvider) {
			await configService.setConfig(ConfigKey.Shared.AuthProvider, configOverrides.authProvider);
		}
		if (configOverrides?.gheUri) {
			await configService.setNonExtensionConfig('github-enterprise.uri', configOverrides.gheUri);
		}
		if (configOverrides?.toolsets) {
			await configService.setConfig(ConfigKey.GitHubMcpToolsets, configOverrides.toolsets);
		}

		serviceCollection.define(IConfigurationService, configService);
		const accessor = serviceCollection.createTestingAccessor();
		return disposables.add(new GitHubMcpDefinitionProvider(
			accessor.get(IConfigurationService)
		));
	}

	beforeEach(async () => {
		disposables = new DisposableStore();
		provider = await createProvider();
	});

	afterEach(() => {
		disposables.dispose();
	});

	describe('provideMcpServerDefinitions', () => {
		test('returns GitHub.com configuration by default', () => {
			const definitions = provider.provideMcpServerDefinitions();

			expect(definitions).toHaveLength(1);
			expect(definitions[0].label).toBe('GitHub');
			expect(definitions[0].uri.toString()).toBe('https://api.githubcopilot.com/mcp/');
			expect(definitions[0].authentication?.providerId).toBe(AuthProviderId.GitHub);
			expect(definitions[0].authentication?.scopes).toBe(GITHUB_SCOPE_ALIGNED);
		});

		test('returns GitHub Enterprise configuration when auth provider is set to GHE', async () => {
			const gheUri = 'https://github.enterprise.com';
			const gheProvider = await createProvider({
				authProvider: AuthProviderId.GitHubEnterprise,
				gheUri
			});

			const definitions = gheProvider.provideMcpServerDefinitions();

			expect(definitions).toHaveLength(1);
			expect(definitions[0].label).toBe('GitHub Enterprise');
			// URI.parse adds a trailing slash to bare domain URIs
			expect(definitions[0].uri.toString()).toBe(gheUri + '/mcp/');
			expect(definitions[0].authentication?.providerId).toBe(AuthProviderId.GitHubEnterprise);
			expect(definitions[0].authentication?.scopes).toBe(GITHUB_SCOPE_ALIGNED);
		});

		test('includes configured toolsets in headers', async () => {
			const toolsets = ['code_search', 'issues', 'pull_requests'];
			const providerWithToolsets = await createProvider({ toolsets });

			const definitions = providerWithToolsets.provideMcpServerDefinitions();

			expect(definitions[0].headers['X-MCP-Toolsets']).toBe('code_search,issues,pull_requests');
		});

		test('handles empty toolsets configuration', async () => {
			const providerWithEmptyToolsets = await createProvider({ toolsets: [] });

			const definitions = providerWithEmptyToolsets.provideMcpServerDefinitions();

			expect(definitions[0].headers['X-MCP-Toolsets']).toBe('');
		});

		test('increments version on each call', () => {
			const def1 = provider.provideMcpServerDefinitions();
			const def2 = provider.provideMcpServerDefinitions();
			const def3 = provider.provideMcpServerDefinitions();

			expect(def1[0].version).toBe('1.0');
			expect(def2[0].version).toBe('1.1');
			expect(def3[0].version).toBe('1.2');
		});

		test('throws when GHE is configured but URI is missing', async () => {
			const gheProviderWithoutUri = await createProvider({
				authProvider: AuthProviderId.GitHubEnterprise
				// Don't set the GHE URI
			});

			expect(() => gheProviderWithoutUri.provideMcpServerDefinitions()).toThrow('GitHub Enterprise URI is not configured.');
		});
	});

	describe('onDidChangeMcpServerDefinitions', () => {
		test('fires when toolsets configuration changes', async () => {
			const eventPromise = Event.toPromise(provider.onDidChangeMcpServerDefinitions);

			await configService.setConfig(ConfigKey.GitHubMcpToolsets, ['new_toolset']);

			await eventPromise;
		});

		test('fires when auth provider configuration changes', async () => {
			const eventPromise = Event.toPromise(provider.onDidChangeMcpServerDefinitions);

			await configService.setConfig(ConfigKey.Shared.AuthProvider, AuthProviderId.GitHubEnterprise);

			await eventPromise;
		});

		test('fires when GHE URI configuration changes', async () => {
			await configService.setConfig(ConfigKey.Shared.AuthProvider, AuthProviderId.GitHubEnterprise);
			await configService.setNonExtensionConfig('github-enterprise.uri', 'https://old.enterprise.com');

			const eventPromise = Event.toPromise(provider.onDidChangeMcpServerDefinitions);

			await configService.setNonExtensionConfig('github-enterprise.uri', 'https://new.enterprise.com');

			await eventPromise;
		});

		test('does not fire for unrelated configuration changes', async () => {
			let eventFired = false;
			disposables.add(provider.onDidChangeMcpServerDefinitions(() => {
				eventFired = true;
			}));

			await configService.setNonExtensionConfig('some.unrelated.config', 'value');

			const eventPromise = new Promise<void>(resolve => {
				disposables.add(provider.onDidChangeMcpServerDefinitions(() => resolve()));
			});
			const result = await raceTimeout(eventPromise, 50);

			expect(result).toBeUndefined();
			expect(eventFired).toBe(false);
		});
	});

	describe('edge cases', () => {
		test('uses default toolsets value when not configured', () => {
			const definitions = provider.provideMcpServerDefinitions();

			expect(definitions).toHaveLength(1);
			expect(definitions[0].headers['X-MCP-Toolsets']).toBe('default');
		});
	});
});
