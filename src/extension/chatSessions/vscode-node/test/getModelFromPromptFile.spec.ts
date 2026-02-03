/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { describe, it } from 'vitest';

// Mock ICopilotCLIModels for testing
class MockCopilotCLIModels {
	async resolveModel(modelId: string): Promise<string | undefined> {
		modelId = modelId.trim().toLowerCase();
		// Simulate a simple model registry
		const knownModels: Record<string, string> = {
			'gpt-4.1': 'gpt-4.1',
			'gpt-4o': 'gpt-4o',
			'claude-3.5-sonnet': 'claude-3.5-sonnet',
		};
		return knownModels[modelId];
	}
}

// Copy of the function being tested
async function getModelFromPromptFile(models: readonly string[], copilotCLIModels: MockCopilotCLIModels): Promise<string | undefined> {
	for (const model of models) {
		let modelId = await copilotCLIModels.resolveModel(model);
		if (modelId) {
			return modelId;
		}
		// Sometimes the models can contain ` (Copilot)` suffix, try stripping that and resolving again.
		if (!model.includes('(')) {
			continue;
		}
		modelId = await copilotCLIModels.resolveModel(model.substring(0, model.indexOf('(')).trim());
		if (modelId) {
			return modelId;
		}
	}
	return undefined;
}

describe('getModelFromPromptFile', () => {
	it('should return the first model that can be resolved', async () => {
		const models = ['GPT-4.1', 'GPT-4o', 'Claude-3.5-Sonnet'];
		const mockCLIModels = new MockCopilotCLIModels();
		
		const result = await getModelFromPromptFile(models, mockCLIModels);
		
		assert.equal(result, 'gpt-4.1', 'Should return the first model');
	});

	it('should skip unresolvable models and return the first resolvable one', async () => {
		const models = ['Invalid-Model', 'GPT-4o', 'Claude-3.5-Sonnet'];
		const mockCLIModels = new MockCopilotCLIModels();
		
		const result = await getModelFromPromptFile(models, mockCLIModels);
		
		assert.equal(result, 'gpt-4o', 'Should skip invalid and return GPT-4o');
	});

	it('should return the third model if first two are invalid', async () => {
		const models = ['Invalid-Model-1', 'Invalid-Model-2', 'Claude-3.5-Sonnet'];
		const mockCLIModels = new MockCopilotCLIModels();
		
		const result = await getModelFromPromptFile(models, mockCLIModels);
		
		assert.equal(result, 'claude-3.5-sonnet', 'Should return the third model');
	});

	it('should return undefined if no models can be resolved', async () => {
		const models = ['Invalid-Model-1', 'Invalid-Model-2', 'Invalid-Model-3'];
		const mockCLIModels = new MockCopilotCLIModels();
		
		const result = await getModelFromPromptFile(models, mockCLIModels);
		
		assert.isUndefined(result, 'Should return undefined when no models resolve');
	});

	it('should handle models with (Copilot) suffix', async () => {
		const models = ['GPT-4.1 (Copilot)', 'GPT-4o', 'Claude-3.5-Sonnet'];
		const mockCLIModels = new MockCopilotCLIModels();
		
		const result = await getModelFromPromptFile(models, mockCLIModels);
		
		assert.equal(result, 'gpt-4.1', 'Should strip suffix and resolve GPT-4.1');
	});
});
