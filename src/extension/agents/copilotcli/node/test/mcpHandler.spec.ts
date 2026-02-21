/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticationSession } from 'vscode';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { NullMcpService } from '../../../../../platform/mcp/common/mcpService';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { Event } from '../../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { McpHttpServerDefinition, McpStdioServerDefinition } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { CopilotCLIMCPHandler } from '../mcpHandler';

class TestMcpService extends NullMcpService {
	override mcpServerDefinitions: (McpStdioServerDefinition | McpHttpServerDefinition)[] = [];
}

class TestAuthenticationService extends mock<IAuthenticationService>() {
	override readonly onDidAuthenticationChange: Event<void> = Event.None;
	override readonly onDidAccessTokenChange: Event<void> = Event.None;
	override readonly onDidAdoAuthenticationChange: Event<void> = Event.None;
	override permissiveGitHubSession: AuthenticationSession | undefined = {
		id: 'test-session',
		accessToken: 'test-token-123',
		scopes: [],
		account: { id: 'test', label: 'test' },
	};

	override getGitHubSession(_: unknown, __: unknown): Promise<AuthenticationSession | undefined | any> {
		return Promise.resolve(this.permissiveGitHubSession);
	}
}

describe('CopilotCLIMCPHandler', () => {
	const disposables = new DisposableStore();
	let logService: TestLogService;
	let authService: TestAuthenticationService;
	let configService: InMemoryConfigurationService;
	let mcpService: TestMcpService;
	let handler: CopilotCLIMCPHandler;

	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		const baseConfigService = accessor.get(IConfigurationService);

		logService = new TestLogService();
		authService = new TestAuthenticationService();
		configService = new InMemoryConfigurationService(baseConfigService);
		mcpService = disposables.add(new TestMcpService());

		// Enable CLI MCP server by default for tests
		configService.setConfig(ConfigKey.Advanced.CLIMCPServerEnabled, true);

		handler = new CopilotCLIMCPHandler(logService, authService, configService, mcpService);
	});

	afterEach(() => {
		disposables.clear();
	});

	describe('loadMcpConfig', () => {
		it('returns undefined when CLI MCP server is disabled', async () => {
			configService.setConfig(ConfigKey.Advanced.CLIMCPServerEnabled, false);
			const result = await handler.loadMcpConfig();
			expect(result).toBeUndefined();
		});

		it('returns config with built-in GitHub server when no MCP definitions exist', async () => {
			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			expect(result!['github']).toBeDefined();
			expect(result!['github'].type).toBe('http');
			expect(result!['github'].isDefaultServer).toBe(true);
		});

		it('processes stdio server definitions', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('my-server', 'node', ['server.js'], { NODE_ENV: 'test' }),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const config = result!['my-server'];
			expect(config).toBeDefined();
			if (config.type === 'stdio') {
				expect(config.type).toBe('stdio');
				expect(config.command).toBe('node');
				expect(config.args).toEqual(['server.js']);
				expect(config.env).toEqual({ NODE_ENV: 'test' });
				expect(config.tools).toEqual(['*']);
				expect(config.displayName).toBe('my-server');
			} else {
				throw new Error('Expected stdio server config');
			}
		});

		it('processes stdio server with cwd', async () => {
			const def = new McpStdioServerDefinition('test-server', 'python', ['run.py']);
			(def as any).cwd = URI.file('/workspace/project');
			mcpService.mcpServerDefinitions = [def];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const config = result!['test-server'];
			expect(config).toBeDefined();
			if (config.type === 'stdio') {
				expect(config.cwd).toBe('/workspace/project');
			} else {
				throw new Error('Expected stdio server config');
			}
		});

		it('skips stdio server with missing command', async () => {
			const def = new McpStdioServerDefinition('no-cmd', '', []);
			mcpService.mcpServerDefinitions = [def];

			const result = await handler.loadMcpConfig();
			// Should only have the built-in GitHub server
			expect(result).toBeDefined();
			expect(result!['no-cmd']).toBeUndefined();
		});

		it('filters non-string env values from stdio servers', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('env-server', 'node', [], { STR: 'hello', NUM: 42, NULL_VAL: null }),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const config = result!['env-server'];
			expect(config).toBeDefined();
			if (config.type === 'stdio') {
				expect(config.env).toEqual({ STR: 'hello' });
			} else {
				throw new Error('Expected stdio server config');
			}
		});

		it('processes http server definitions', async () => {
			mcpService.mcpServerDefinitions = [
				new McpHttpServerDefinition('remote-server', URI.parse('https://example.com/mcp'), { 'X-API-Key': 'secret' }),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const config = result!['remote-server'];
			expect(config).toBeDefined();
			expect(config.type).toBe('http');
			if (config.type === 'http') {
				expect(config).toHaveProperty('url', 'https://example.com/mcp');
				expect(config.headers).toEqual({ 'X-API-Key': 'secret' });
				expect(config.tools).toEqual(['*']);
			} else {
				throw new Error('Expected http server config');
			}
		});

		it('processes a mix of stdio and http definitions', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('local', 'node', ['app.js']),
				new McpHttpServerDefinition('remote', URI.parse('https://example.com/mcp')),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			expect(result!['local']).toBeDefined();
			expect(result!['local'].type).toBe('stdio');
			expect(result!['remote']).toBeDefined();
			expect(result!['remote'].type).toBe('http');
		});
	});

	describe('server name normalization', () => {
		it('normalizes names with special characters', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('My Cool Server!', 'node', ['server.js']),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			// "My Cool Server!" -> "my_cool_server_" -> trailing underscores trimmed -> "my_cool_server"
			expect(result!['my_cool_server']).toBeDefined();
		});

		it('normalizes names with leading/trailing underscores', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('___test___', 'node', ['server.js']),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			expect(result!['test']).toBeDefined();
		});

		it('skips servers whose names normalize to empty string', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('!!!', 'node', ['server.js']),
			];

			const result = await handler.loadMcpConfig();
			// Should only have GitHub server, not the !!!-named server
			expect(result).toBeDefined();
			const keys = Object.keys(result!);
			expect(keys).not.toContain('');
		});

		it('handles name collisions by appending UUID suffix', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('my-server', 'node', ['a.js']),
				new McpStdioServerDefinition('my-server', 'node', ['b.js']),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			// First one gets the base name
			expect(result!['my-server']).toBeDefined();
			// Second one should get a UUID-suffixed name
			const keys = Object.keys(result!).filter(k => k.startsWith('my-server'));
			expect(keys.length).toBe(2);
			const suffixedKey = keys.find(k => k !== 'my-server')!;
			expect(suffixedKey).toMatch(/^my-server_[a-z0-9]{8}$/);
		});

		it('preserves already-valid lowercase names', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('valid-name', 'node', ['server.js']),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			expect(result!['valid-name']).toBeDefined();
		});

		it('lowercases uppercase names', async () => {
			mcpService.mcpServerDefinitions = [
				new McpStdioServerDefinition('MyServer', 'node', ['server.js']),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			expect(result!['myserver']).toBeDefined();
		});
	});

	describe('addBuiltInGitHubServer', () => {
		it('adds GitHub server with auth token', async () => {
			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const github = result!['github'];
			expect(github).toBeDefined();
			expect(github.type).toBe('http');
			if (github.type === 'http') {
				expect(github.isDefaultServer).toBe(true);
				expect(github.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
				expect(github.tools).toEqual(['*']);
				expect(github.displayName).toBe('GitHub');
			} else {
				throw new Error('Expected http server config');
			}
		});

		it('does not override existing GitHub server with headers', async () => {
			mcpService.mcpServerDefinitions = [
				new McpHttpServerDefinition('github', URI.parse('https://custom-github.com/mcp'), { 'Authorization': 'Bearer custom-token' }),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const github = result!['github'];
			expect(github).toBeDefined();
			if (github.type === 'http') {
				expect(github.headers).toEqual({ 'Authorization': 'Bearer custom-token' });
			} else {
				throw new Error('Expected http server config');
			}
		});

		it('overrides existing GitHub server without headers', async () => {
			mcpService.mcpServerDefinitions = [
				new McpHttpServerDefinition('github', URI.parse('https://custom-github.com/mcp')),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const github = result!['github'];
			expect(github).toBeDefined();
			// Should override since the existing one had no headers
			if (github.type === 'http') {
				expect(github.isDefaultServer).toBe(true);
				expect(github.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
				// Should preserve the URL from the existing config
				expect(github).toHaveProperty('url', 'https://custom-github.com/mcp');
			} else {
				throw new Error('Expected http server config');
			}
		});

		it('detects GitHub server by io_github_github_github-mcp-server key', async () => {
			mcpService.mcpServerDefinitions = [
				new McpHttpServerDefinition('io.github.github.github-mcp-server', URI.parse('https://custom.com/mcp'), { 'Authorization': 'custom' }),
			];

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			// The normalized name of "io.github.github.github-mcp-server" includes dots -> underscores
			// The detection should match before built-in server is added
			const key = 'io_github_github_github-mcp-server';
			const config = result![key];
			expect(config).toBeDefined();
			if (config.type === 'http') {
				expect(config.headers).toEqual({ 'Authorization': 'custom' });
			} else {
				throw new Error('Expected http server config');
			}
		});

		it('handles auth failure gracefully', async () => {
			authService.getGitHubSession = () => Promise.reject(new Error('Auth failed'));

			const result = await handler.loadMcpConfig();
			// Should not throw, just skip GitHub server
			// Result could be undefined if no other servers exist
			if (result) {
				expect(result['github']).toBeUndefined();
			}
		});

		it('handles no authentication session gracefully', async () => {
			authService.getGitHubSession = () => Promise.resolve(undefined);

			const result = await handler.loadMcpConfig();
			// Should not throw - resolveMcpServerDefinition will throw 'Authentication required'
			// which is caught by addBuiltInGitHubServer
			if (result) {
				expect(result['github']).toBeUndefined();
			}
		});

		it('preserves tools from existing GitHub http config', async () => {
			mcpService.mcpServerDefinitions = [
				new McpHttpServerDefinition('github', URI.parse('https://api.githubcopilot.com/mcp/')),
			];
			// The definition has no headers, so it will be overridden
			// But tools should be ['*'] since the existing had empty tools initially

			const result = await handler.loadMcpConfig();
			expect(result).toBeDefined();
			const github = result!['github'];
			expect(github).toBeDefined();
			if (github.type === 'http') {
				expect(github.tools).toEqual(['*']);
			} else {
				throw new Error('Expected http server config');
			}
		});
	});
});
