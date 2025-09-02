/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { LanguageContextResponse } from '../../../../platform/inlineEdits/common/dataTypes/languageContext';
import { PromptOptions } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditRequest } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';

/**
 * Props for all prompt strategy components
 */
export interface PromptStrategyProps extends BasePromptElementProps {
	readonly request: StatelessNextEditRequest;
	readonly currentFileContent: string;
	readonly areaAroundCodeToEdit: string;
	readonly langCtx: LanguageContextResponse | undefined;
	readonly computeTokens: (s: string) => number;
	readonly opts: PromptOptions;
}

/**
 * Base class for all prompt strategy components
 */
export abstract class PromptStrategyBase extends PromptElement<PromptStrategyProps> {
	/**
	 * System prompt for this strategy
	 */
	protected abstract getSystemPrompt(): string;

	/**
	 * Whether to include backticks around the main prompt content
	 */
	protected abstract shouldIncludeBackticks(): boolean;

	/**
	 * Get the post-script content for this strategy
	 */
	protected abstract getPostScript(currentFilePath: string): string;

	/**
	 * Render the complete prompt with system and user messages
	 */
	render() {
		const systemPrompt = this.getSystemPrompt();
		const userPrompt = this.buildUserPrompt();

		return (
			<>
				<SystemMessage priority={1000}>
					{systemPrompt}
				</SystemMessage>
				<UserMessage priority={900}>
					{userPrompt}
				</UserMessage>
			</>
		);
	}

	/**
	 * Build the user prompt content - to be implemented using existing functions
	 */
	protected abstract buildUserPrompt(): string;

	/**
	 * Wrap content in backticks
	 */
	protected wrapInBackticks(content: string): string {
		return `\`\`\`\n${content}\n\`\`\``;
	}
}