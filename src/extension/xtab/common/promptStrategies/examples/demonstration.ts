/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Demonstration script showing how to use and extend the modular prompt construction system
 * 
 * This file is for documentation/demonstration purposes only and is not part of the runtime code.
 */

import { PromptingStrategy } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { createPromptStrategy, registerPromptStrategy, type PromptStrategyProps } from '../promptStrategies';
import { PromptStrategyBase } from '../promptStrategies/promptStrategyBase';

// Example 1: Using existing strategies
function demonstrateExistingStrategies() {
	console.log('=== Demonstrating Existing Strategies ===\n');

	const mockProps: PromptStrategyProps = {
		request: {} as any,
		currentFileContent: 'function example() {\n  return "hello";\n}',
		areaAroundCodeToEdit: '<|area_around_code_to_edit|>\nfunction example() {\n  return "hello";\n}\n<|/area_around_code_to_edit|>',
		langCtx: undefined,
		computeTokens: (s: string) => Math.ceil(s.length / 4),
		opts: {
			promptingStrategy: PromptingStrategy.SimplifiedSystemPrompt,
			currentFile: { maxTokens: 2000, includeTags: true, prioritizeAboveCursor: false },
			pagedClipping: { pageSize: 10 },
			recentlyViewedDocuments: { nDocuments: 5, maxTokens: 2000, includeViewedFiles: false },
			languageContext: { enabled: false, maxTokens: 2000 },
			diffHistory: { nEntries: 25, maxTokens: 1000, onlyForDocsInPrompt: false, useRelativePaths: false }
		}
	};

	// Create different strategies
	const strategies = [
		{ name: 'Simplified', type: PromptingStrategy.SimplifiedSystemPrompt },
		{ name: 'Unified Model', type: PromptingStrategy.UnifiedModel },
		{ name: 'Xtab275', type: PromptingStrategy.Xtab275 },
		{ name: 'Default', type: undefined }
	];

	strategies.forEach(({ name, type }) => {
		console.log(`--- ${name} Strategy ---`);
		const strategy = createPromptStrategy(type, mockProps);
		
		const systemPrompt = (strategy as any).getSystemPrompt();
		const shouldIncludeBackticks = (strategy as any).shouldIncludeBackticks();
		const postScript = (strategy as any).getPostScript('/example/file.ts');
		
		console.log(`System Prompt: ${systemPrompt.substring(0, 100)}...`);
		console.log(`Include Backticks: ${shouldIncludeBackticks}`);
		console.log(`Post Script: ${postScript.substring(0, 100)}...`);
		console.log('');
	});
}

// Example 2: Creating a custom strategy
class DebugPromptStrategy extends PromptStrategyBase {
	protected getSystemPrompt(): string {
		return `You are a debugging assistant. Help developers identify and fix bugs in their code.

Focus on:
- Identifying potential runtime errors
- Spotting logical issues  
- Suggesting defensive programming practices
- Recommending better error handling

Always explain your reasoning and provide clear, actionable suggestions.`;
	}

	protected shouldIncludeBackticks(): boolean {
		return true;
	}

	protected getPostScript(currentFilePath: string): string {
		return `\n\nAnalyze the code in ${currentFilePath} for potential bugs and issues. Provide specific suggestions for improvements with explanations.`;
	}

	protected buildUserPrompt(): string {
		// In a real implementation, this would call getUserPrompt or create custom logic
		return `Please debug this code:\n${this.props.currentFileContent}\n\nArea to focus on:\n${this.props.areaAroundCodeToEdit}`;
	}
}

// Example 3: Extending the system
function demonstrateExtensibility() {
	console.log('=== Demonstrating Extensibility ===\n');

	// Simulate adding a new strategy to the enum (this would be done in the actual enum file)
	const CustomDebugStrategy = 'customDebug' as PromptingStrategy;

	// Register the new strategy
	registerPromptStrategy(CustomDebugStrategy, DebugPromptStrategy);

	const mockProps: PromptStrategyProps = {
		request: {} as any,
		currentFileContent: 'function divide(a, b) {\n  return a / b;\n}',
		areaAroundCodeToEdit: '<|area_around_code_to_edit|>\nfunction divide(a, b) {\n  return a / b;\n}\n<|/area_around_code_to_edit|>',
		langCtx: undefined,
		computeTokens: (s: string) => Math.ceil(s.length / 4),
		opts: {
			promptingStrategy: CustomDebugStrategy,
			currentFile: { maxTokens: 2000, includeTags: true, prioritizeAboveCursor: false },
			pagedClipping: { pageSize: 10 },
			recentlyViewedDocuments: { nDocuments: 5, maxTokens: 2000, includeViewedFiles: false },
			languageContext: { enabled: false, maxTokens: 2000 },
			diffHistory: { nEntries: 25, maxTokens: 1000, onlyForDocsInPrompt: false, useRelativePaths: false }
		}
	};

	// Use the custom strategy
	const customStrategy = createPromptStrategy(CustomDebugStrategy, mockProps);
	
	console.log('--- Custom Debug Strategy ---');
	console.log(`System Prompt: ${(customStrategy as any).getSystemPrompt()}`);
	console.log(`User Prompt: ${(customStrategy as any).buildUserPrompt()}`);
	console.log('');
}

// Example 4: Benefits demonstration
function demonstrateBenefits() {
	console.log('=== Benefits of the New System ===\n');

	console.log('✅ Modularity:');
	console.log('  - Each strategy is self-contained');
	console.log('  - Easy to understand and modify individual strategies');
	console.log('  - Clear separation of concerns\n');

	console.log('✅ Flexibility:');
	console.log('  - Easy to experiment with different prompt variations');
	console.log('  - A/B testing different strategies becomes trivial');
	console.log('  - Can mix and match different aspects of strategies\n');

	console.log('✅ Extensibility:');
	console.log('  - Adding new strategies requires minimal code changes');
	console.log('  - No need to modify existing switch statements');
	console.log('  - Strategy registry automatically handles new strategies\n');

	console.log('✅ Maintainability:');
	console.log('  - No more large string concatenations');
	console.log('  - No more complex switch statements');
	console.log('  - Each strategy documents its own behavior');
	console.log('  - Easy to test individual strategies\n');
}

// Run demonstrations
if (require.main === module) {
	demonstrateExistingStrategies();
	demonstrateExtensibility();
	demonstrateBenefits();
}