/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { PromptingStrategy } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { createPromptStrategy, promptStrategyRegistry, SimplifiedPromptStrategy, UnifiedModelPromptStrategy } from '../../common/promptStrategies';
import type { PromptStrategyProps } from '../../common/promptStrategies';

// Mock props for testing
function createMockProps(): PromptStrategyProps {
	return {
		request: {} as any, // Simplified mock
		currentFileContent: 'function example() {\n  // TODO: implement\n}',
		areaAroundCodeToEdit: '<|area_around_code_to_edit|>\nfunction example() {\n  // TODO: implement\n}\n<|/area_around_code_to_edit|>',
		langCtx: undefined,
		computeTokens: (s: string) => Math.ceil(s.length / 4),
		opts: {
			promptingStrategy: undefined,
			currentFile: { maxTokens: 2000, includeTags: true, prioritizeAboveCursor: false },
			pagedClipping: { pageSize: 10 },
			recentlyViewedDocuments: { nDocuments: 5, maxTokens: 2000, includeViewedFiles: false },
			languageContext: { enabled: false, maxTokens: 2000 },
			diffHistory: { nEntries: 25, maxTokens: 1000, onlyForDocsInPrompt: false, useRelativePaths: false }
		}
	};
}

suite('Prompt Strategy System', () => {
	test('can create strategies from registry', () => {
		const props = createMockProps();
		
		const simplifiedStrategy = createPromptStrategy(PromptingStrategy.SimplifiedSystemPrompt, props);
		expect(simplifiedStrategy).toBeInstanceOf(SimplifiedPromptStrategy);

		const unifiedStrategy = createPromptStrategy(PromptingStrategy.UnifiedModel, props);
		expect(unifiedStrategy).toBeInstanceOf(UnifiedModelPromptStrategy);
	});

	test('simplified strategy has correct system prompt', () => {
		const props = createMockProps();
		const strategy = createPromptStrategy(PromptingStrategy.SimplifiedSystemPrompt, props);
		
		const systemPrompt = (strategy as any).getSystemPrompt();
		expect(systemPrompt).toBe('Predict next code edit based on the context given by the user.');
	});

	test('unified model strategy should not include backticks', () => {
		const props = createMockProps();
		const strategy = createPromptStrategy(PromptingStrategy.UnifiedModel, props);
		
		const shouldIncludeBackticks = (strategy as any).shouldIncludeBackticks();
		expect(shouldIncludeBackticks).toBe(false);
	});

	test('simplified strategy should include backticks', () => {
		const props = createMockProps();
		const strategy = createPromptStrategy(PromptingStrategy.SimplifiedSystemPrompt, props);
		
		const shouldIncludeBackticks = (strategy as any).shouldIncludeBackticks();
		expect(shouldIncludeBackticks).toBe(true);
	});

	test('registry knows about all default strategies', () => {
		expect(promptStrategyRegistry.has(PromptingStrategy.UnifiedModel)).toBe(true);
		expect(promptStrategyRegistry.has(PromptingStrategy.SimplifiedSystemPrompt)).toBe(true);
		expect(promptStrategyRegistry.has(PromptingStrategy.Xtab275)).toBe(true);
		expect(promptStrategyRegistry.has(PromptingStrategy.Nes41Miniv3)).toBe(true);
		expect(promptStrategyRegistry.has(PromptingStrategy.Codexv21NesUnified)).toBe(true);
		expect(promptStrategyRegistry.has(undefined)).toBe(true); // default strategy
	});

	test('strategies generate post-scripts with file path', () => {
		const props = createMockProps();
		const strategy = createPromptStrategy(PromptingStrategy.SimplifiedSystemPrompt, props);
		
		const postScript = (strategy as any).getPostScript('/path/to/file.ts');
		expect(postScript).toContain('/path/to/file.ts');
		expect(postScript).toContain('code_to_edit');
	});

	test('throws error for unknown strategy', () => {
		const props = createMockProps();
		
		expect(() => {
			createPromptStrategy('unknown-strategy' as any, props);
		}).toThrow('Unknown prompting strategy: unknown-strategy');
	});
});