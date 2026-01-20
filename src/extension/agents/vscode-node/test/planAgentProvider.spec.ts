/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, describe, suite, test } from 'vitest';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { buildAgentMarkdown, PlanAgentProvider } from '../planAgentProvider';

/**
 * Helper to extract content from CustomAgentChatResource
 */
function getAgentContent(agent: vscode.CustomAgentChatResource): string {
	const resource = agent.resource as { id: string; content: string };
	return resource.content;
}

suite('PlanAgentProvider', () => {
	let disposables: DisposableStore;
	let mockConfigurationService: InMemoryConfigurationService;
	let accessor: any;

	beforeEach(() => {
		disposables = new DisposableStore();

		// Set up testing services
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		mockConfigurationService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createProvider() {
		const provider = new PlanAgentProvider(
			mockConfigurationService,
			accessor.get(ILogService),
		);
		disposables.add(provider);
		return provider;
	}

	test('provideCustomAgents() returns a Plan agent with correct structure', async () => {
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const resource = agents[0].resource as { id: string; content: string };
		assert.equal(resource.id, 'github.copilot.plan');
		assert.ok(resource.content, 'Agent should have inline content');
	});

	test('returns agent content with base frontmatter when no settings configured', async () => {
		const provider = createProvider();

		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should contain base tools
		assert.ok(content.includes('github/issue_read'));
		assert.ok(content.includes('agent'));
		assert.ok(content.includes('search'));
		assert.ok(content.includes('read'));

		// Should not have model override (not in base content)
		assert.ok(content.includes('name: Plan'));
		assert.ok(content.includes('description: Researches and outlines multi-step plans'));
	});

	test('merges additionalTools setting with base tools', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.AdditionalTools, ['customTool1', 'customTool2']);

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should contain base tools
		assert.ok(content.includes('github/issue_read'));
		assert.ok(content.includes('agent'));

		// Should contain additional tools
		assert.ok(content.includes('customTool1'));
		assert.ok(content.includes('customTool2'));
	});

	test('deduplicates tools when additionalTools overlaps with base tools', async () => {
		// Add a tool that already exists in base
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.AdditionalTools, ['agent', 'newTool']);

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Count occurrences of 'agent' in tools list (flow-style array)
		// Should appear only once due to deduplication
		const toolsMatch = content.match(/tools: \[([^\]]+)\]/);
		if (toolsMatch) {
			const toolsSection = toolsMatch[1];
			const agentCount = (toolsSection.match(/'agent'/g) || []).length;
			assert.equal(agentCount, 1, 'agent tool should appear only once after deduplication');
		}

		// Should contain new tool
		assert.ok(content.includes('newTool'));
	});

	test('applies model override from settings', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.Model, 'gpt-4-turbo');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should contain model override
		assert.ok(content.includes('model: gpt-4-turbo'));
	});

	test('applies both additionalTools and model settings together', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.AdditionalTools, ['extraTool']);
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.Model, 'claude-3-sonnet');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should contain additional tool
		assert.ok(content.includes('extraTool'));

		// Should contain model override
		assert.ok(content.includes('model: claude-3-sonnet'));
	});

	test('fires onDidChangeCustomAgents when additionalTools setting changes', async () => {
		const provider = createProvider();

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.AdditionalTools, ['newTool']);

		assert.equal(eventFired, true);
	});

	test('fires onDidChangeCustomAgents when model setting changes', async () => {
		const provider = createProvider();

		let eventFired = false;
		provider.onDidChangeCustomAgents(() => {
			eventFired = true;
		});

		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.Model, 'new-model');

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
		assert.ok(provider.label.includes('Plan'));
	});

	test('preserves body content after frontmatter when applying settings', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.Model, 'test-model');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		const content = getAgentContent(agents[0]);

		// Should preserve body content
		assert.ok(content.includes('You are a PLANNING AGENT, NOT an implementation agent.'));
		assert.ok(content.includes('Your SOLE responsibility is planning, NEVER even consider to start implementation.'));
	});

	test('handles empty additionalTools array gracefully', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.AdditionalTools, []);

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should have base tools only
		assert.ok(content.includes('github/issue_read'));
		assert.ok(content.includes('agent'));
	});

	test('handles empty model string gracefully', async () => {
		await mockConfigurationService.setConfig(ConfigKey.PlanAgent.Model, '');

		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		assert.equal(agents.length, 1);
		const content = getAgentContent(agents[0]);

		// Should not have model field added
		assert.ok(!content.includes('model:'));
	});

	test('includes handoffs in generated content', async () => {
		const provider = createProvider();
		const agents = await provider.provideCustomAgents({}, {} as any);

		const content = getAgentContent(agents[0]);

		// Should contain handoffs
		assert.ok(content.includes('handoffs:'));
		assert.ok(content.includes('label: Start Implementation'));
		assert.ok(content.includes('label: Open in Editor'));
		assert.ok(content.includes('agent: agent'));
		assert.ok(content.includes('send: true'));
	});
});

suite('buildAgentMarkdown', () => {
	test('generates valid YAML frontmatter with basic config', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test description',
			argumentHint: 'Test hint',
			tools: ['tool1', 'tool2'],
			handoffs: [],
			body: 'Test body content'
		};

		const result = buildAgentMarkdown(config);

		assert.ok(result.startsWith('---\n'));
		assert.ok(result.includes('name: TestAgent'));
		assert.ok(result.includes('description: Test description'));
		assert.ok(result.includes('argument-hint: Test hint'));
		assert.ok(result.includes('tools: [\'tool1\', \'tool2\']'));
		assert.ok(result.includes('---\nTest body content'));
	});

	test('includes model when provided', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			argumentHint: 'Test',
			tools: [],
			model: 'gpt-4-turbo',
			handoffs: [],
			body: 'Body'
		};

		const result = buildAgentMarkdown(config);

		assert.ok(result.includes('model: gpt-4-turbo'));
	});

	test('omits model when not provided', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			argumentHint: 'Test',
			tools: [],
			handoffs: [],
			body: 'Body'
		};

		const result = buildAgentMarkdown(config);

		assert.ok(!result.includes('model:'));
	});

	test('generates handoffs in block style', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			argumentHint: 'Test',
			tools: [],
			handoffs: [
				{
					label: 'Continue',
					agent: 'agent',
					prompt: 'Do the thing',
					send: true
				},
				{
					label: 'Save',
					agent: 'editor',
					prompt: 'Save it',
					showContinueOn: false
				}
			],
			body: 'Body'
		};

		const result = buildAgentMarkdown(config);

		assert.ok(result.includes('handoffs:'));
		assert.ok(result.includes('  - label: Continue'));
		assert.ok(result.includes('    agent: agent'));
		assert.ok(result.includes('    prompt: Do the thing'));
		assert.ok(result.includes('    send: true'));
		assert.ok(result.includes('  - label: Save'));
		assert.ok(result.includes('    showContinueOn: false'));
	});

	test('handles empty tools array', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			argumentHint: 'Test',
			tools: [],
			handoffs: [],
			body: 'Body'
		};

		const result = buildAgentMarkdown(config);

		// Should not have tools line when empty
		assert.ok(!result.includes('tools:'));
	});

	test('quotes tool names in flow-style array', () => {
		const config = {
			name: 'TestAgent',
			description: 'Test',
			argumentHint: 'Test',
			tools: ['github/issue_read', 'mcp_server/custom_tool'],
			handoffs: [],
			body: 'Body'
		};

		const result = buildAgentMarkdown(config);

		assert.ok(result.includes('tools: [\'github/issue_read\', \'mcp_server/custom_tool\']'));
	});
});
