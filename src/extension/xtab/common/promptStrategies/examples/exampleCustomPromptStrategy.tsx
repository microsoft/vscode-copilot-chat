/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getUserPrompt } from '../../promptCrafting';
import { PromptStrategyBase } from '../promptStrategyBase';

/**
 * Example of a custom prompt strategy demonstrating extensibility
 * This is an example showing how easy it is to add new prompt strategies
 */
export class ExampleCustomPromptStrategy extends PromptStrategyBase {
	protected getSystemPrompt(): string {
		return `You are a specialized AI assistant for code editing. Your goal is to provide minimal, focused edits that improve code quality while maintaining the developer's intent.

Focus on:
- Type safety improvements
- Performance optimizations  
- Code readability enhancements
- Bug fixes

Always maintain existing functionality and follow the established coding patterns.`;
	}

	protected shouldIncludeBackticks(): boolean {
		return true;
	}

	protected getPostScript(currentFilePath: string): string {
		return `\n\nAnalyze the code in ${currentFilePath} and provide a minimal, focused edit that improves the code quality while preserving functionality. Respond with only the improved code within the edit tags.`;
	}

	protected buildUserPrompt(): string {
		return getUserPrompt(
			this.props.request,
			this.props.currentFileContent,
			this.props.areaAroundCodeToEdit,
			this.props.langCtx,
			this.props.computeTokens,
			this.props.opts
		);
	}
}