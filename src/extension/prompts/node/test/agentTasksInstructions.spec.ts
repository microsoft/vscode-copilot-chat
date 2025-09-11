/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { LanguageModelToolInformation } from 'vscode';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../../tools/common/toolNames';

describe('AgentTasksInstructions', () => {
	it('should not render when run_task tool is not available', async () => {
		const services = createExtensionUnitTestingServices();
		
		// Import the component here to avoid circular dependencies
		const { AgentTasksInstructions } = await import('../agent/agentPrompt');
		
		const component = services.get('IInstantiationService').createInstance(
			AgentTasksInstructions,
			{ availableTools: [] }  // No tools available
		);

		const result = component.render();
		expect(result).toBe(0);
	});

	it('should render when run_task tool is available and tasks exist', async () => {
		const services = createExtensionUnitTestingServices();
		
		// Mock the ITasksService to return some tasks
		const mockTasksService = {
			getTasks: () => [[{}, [{ type: 'npm', label: 'build', hide: false }]]],
			isTaskActive: () => false
		};
		services.set('ITasksService', mockTasksService);

		// Mock the IPromptPathRepresentationService
		const mockPathService = {
			getFilePath: (path: any) => '/workspace'
		};
		services.set('IPromptPathRepresentationService', mockPathService);

		const availableTools: LanguageModelToolInformation[] = [
			{ name: ToolName.CoreRunTask, description: 'Run task tool' }
		];

		const { AgentTasksInstructions } = await import('../agent/agentPrompt');
		
		const component = services.get('IInstantiationService').createInstance(
			AgentTasksInstructions,
			{ availableTools }
		);

		const result = component.render();
		expect(result).not.toBe(0);
		expect(result).toBeTruthy();
	});

	it('should not render when run_task tool is available but no tasks exist', async () => {
		const services = createExtensionUnitTestingServices();
		
		// Mock the ITasksService to return no tasks
		const mockTasksService = {
			getTasks: () => [],
			isTaskActive: () => false
		};
		services.set('ITasksService', mockTasksService);

		// Mock the IPromptPathRepresentationService
		const mockPathService = {
			getFilePath: (path: any) => '/workspace'
		};
		services.set('IPromptPathRepresentationService', mockPathService);

		const availableTools: LanguageModelToolInformation[] = [
			{ name: ToolName.CoreRunTask, description: 'Run task tool' }
		];

		const { AgentTasksInstructions } = await import('../agent/agentPrompt');
		
		const component = services.get('IInstantiationService').createInstance(
			AgentTasksInstructions,
			{ availableTools }
		);

		const result = component.render();
		expect(result).toBe(0);
	});
});