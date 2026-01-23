/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, suite, test } from 'vitest';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { MockExtensionContext } from '../../../../platform/test/node/extensionContext';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { buildImplementAgentMarkdown, ImplementAgentProvider } from '../implementAgentProvider';

suite('ImplementAgentProvider', () => {
	let disposables: DisposableStore;
	let mockConfigurationService: InMemoryConfigurationService;
	let fileSystemService: IFileSystemService;
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		disposables = new DisposableStore();

		// Set up testing services with a mock extension context that has globalStorageUri
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		const globalStoragePath = path.join(os.tmpdir(), 'implement-agent-test-' + Date.now());
		testingServiceCollection.define(IVSCodeExtensionContext, new SyncDescriptor(MockExtensionContext, [globalStoragePath]));
		accessor = testingServiceCollection.createTestingAccessor();
		disposables.add(accessor);
		instantiationService = accessor.get(IInstantiationService);

		mockConfigurationService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		fileSystemService = accessor.get(IFileSystemService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createProvider() {
		const provider = instantiationService.createInstance(ImplementAgentProvider);
		disposables.add(provider);
		return provider;
	}

	async function getAgentContent(agent: vscode.ChatResource): Promise<string> {
		const content = await fileSystemService.readFile(agent.uri);
		return new TextDecoder().decode(content);
	}

	test('provideCustomAgents() returns an Implement agent with correct structure', async () => {
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		assert.ok(agents[0].uri, 'Agent should have a URI');
		assert.ok(agents[0].uri.path.endsWith('.agent.md'), 'Agent URI should end with .agent.md');
	});

	test('returns agent content with base frontmatter when no settings configured', async () => {
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = await getAgentContent(agents[0]);

		// Should contain base metadata
		assert.ok(content.includes('name: Implement'));
		assert.ok(content.includes('description: Executes an existing plan'));

		// Should not have model override (not in base content)
		assert.ok(!content.includes('model:'));
	});

	test('applies model override from settings', async () => {
		await mockConfigurationService.setConfig(ConfigKey.ImplementAgentModel, 'Claude Haiku 4.5 (copilot)');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = await getAgentContent(agents[0]);

		// Should contain model override
		assert.ok(content.includes('model: Claude Haiku 4.5 (copilot)'));
	});

	test('fires onDidChangeCustomAgents when model setting changes', async () => {
		const provider = createProvider();

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		await mockConfigurationService.setConfig(ConfigKey.ImplementAgentModel, 'new-model');

		assert.equal(eventFired, true);
	});

	test('does not fire onDidChangeCustomAgents for unrelated setting changes', async () => {
		const provider = createProvider();

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		// Set an unrelated config (using a different config key)
		await mockConfigurationService.setConfig(ConfigKey.Advanced.FeedbackOnChange, true);

		assert.equal(eventFired, false);
	});

	test('has correct label property', () => {
		const provider = createProvider();
		assert.ok(provider.label.includes('Implement'));
	});

	test('preserves body content after frontmatter when applying settings', async () => {
		await mockConfigurationService.setConfig(ConfigKey.ImplementAgentModel, 'test-model');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		const content = await getAgentContent(agents[0]);

		// Should preserve body content
		assert.ok(content.includes('You are an IMPLEMENTATION AGENT.'));
		assert.ok(content.includes('Focus on implementation, not planning or redesigning.'));
	});

	test('handles empty model string gracefully', async () => {
		await mockConfigurationService.setConfig(ConfigKey.ImplementAgentModel, '');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = await getAgentContent(agents[0]);

		// Should not have model field added
		assert.ok(!content.includes('model:'));
	});
});

suite('buildImplementAgentMarkdown', () => {
	test('generates expected full content for Implement agent (snapshot test)', () => {
		const config = {
			name: 'Implement',
			description: 'Executes an existing plan',
			model: 'Claude Haiku 4.5 (copilot)',
			body: 'You are an IMPLEMENTATION AGENT.'
		};

		const result = buildImplementAgentMarkdown(config);

		assert.deepStrictEqual(result,
			`---
name: Implement
description: Executes an existing plan
model: Claude Haiku 4.5 (copilot)
---
You are an IMPLEMENTATION AGENT.`);
	});

	test('generates valid YAML frontmatter with basic config', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test description',
			body: 'Test body content'
		};

		const result = buildImplementAgentMarkdown(config);

		assert.ok(result.startsWith('---\n'));
		assert.ok(result.includes('name: TestAgent'));
		assert.ok(result.includes('description: Test description'));
		assert.ok(result.includes('---\nTest body content'));
	});

	test('includes model when provided', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			model: 'Claude Haiku 4.5 (copilot)',
			body: 'Body'
		};

		const result = buildImplementAgentMarkdown(config);

		assert.ok(result.includes('model: Claude Haiku 4.5 (copilot)'));
	});

	test('omits model when not provided', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			body: 'Body'
		};

		const result = buildImplementAgentMarkdown(config);

		assert.ok(!result.includes('model:'));
	});
});
