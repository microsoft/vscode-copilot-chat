/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, TextChunk, UserMessage } from '@vscode/prompt-tsx';
import { Turn } from '../../prompt/common/conversation';
import { InstructionMessage } from '../../prompts/node/base/instructionMessage';
import { ResponseTranslationRules } from '../../prompts/node/base/responseTranslationRules';
import { SafetyRules } from '../../prompts/node/base/safetyRules';
import { Tag } from '../../prompts/node/base/tag';
import { HistoryWithInstructions } from '../../prompts/node/panel/conversationHistory';

export interface PromptSavePromptProps extends BasePromptElementProps {
	/**
	 * The conversation history to analyze
	 */
	readonly history: readonly Turn[];

	/**
	 * Optional: The user's final query that triggered the save
	 */
	readonly currentQuery?: string;
}

/**
 * Prompt for analyzing chat conversations and extracting reusable prompt tasks.
 * Used by the /save command to generate prompt file metadata.
 */
export class PromptSavePrompt extends PromptElement<PromptSavePromptProps> {
	override render() {
		return (
			<>
				<SystemMessage priority={1000}>
					You are an expert at analyzing chat conversations and extracting reusable prompt patterns. Your task is to analyze a conversation between a user and an AI assistant, then create a generalized, reusable prompt task definition.<br />
					<SafetyRules />
				</SystemMessage>
				<HistoryWithInstructions historyPriority={800} passPriority history={this.props.history}>
					<InstructionMessage priority={1000}>
						<PromptSaveRules />
						<ResponseTranslationRules />
					</InstructionMessage>
				</HistoryWithInstructions>
				<UserMessage priority={900}>
					{this.props.currentQuery && <>Current request: {this.props.currentQuery}<br /><br /></>}
					Analyze the conversation above and extract a reusable prompt task. Return your analysis as a JSON object wrapped in a markdown code block with triple backticks (```json).<br />
					<br />
					The JSON object must match this structure:<br />
					<Tag name='schema'>
						<TextChunk breakOnWhitespace>
							{`{
  "title": "kebab-case-filename",
  "description": "Brief description of the prompt's purpose (1-2 sentences)",
  "prompt": "Generalized prompt text that can be reused for similar tasks"
}`}
						</TextChunk>
					</Tag>
				</UserMessage>
			</>
		);
	}
}

class PromptSaveRules extends PromptElement {
	render() {
		return (
			<>
				Think step by step:<br />
				1. Review the conversation to identify the user's primary goal or task pattern<br />
				2. Extract the core intent, removing conversation-specific details (e.g., specific file names, variable names, or project-specific context)<br />
				3. Identify any recurring instructions, constraints, or requirements that define how the task should be approached<br />
				4. Generalize the task into a reusable prompt that could apply to similar scenarios<br />
				5. Create a concise title in kebab-case format (e.g., "generate-unit-tests", "refactor-for-performance", "explain-api-design")<br />
				6. Write a brief description (1-2 sentences) explaining what the prompt accomplishes<br />
				7. Craft the generalized prompt text, using placeholders where appropriate (e.g., "the selected code", "the current file", "the specified functionality")<br />
				<br />
				Guidelines for creating the prompt:<br />
				- Focus on the pattern of interaction, not specific implementation details<br />
				- Preserve important constraints or requirements (e.g., "follow test-driven development", "maintain backward compatibility")<br />
				- Use general terms rather than specific names (e.g., "the function" instead of "calculateTotal")<br />
				- Keep the prompt concise but complete - it should provide clear direction without unnecessary verbosity<br />
				- The prompt should work as a standalone instruction that captures the essence of the conversation's goal<br />
				<br />
				Example good titles:<br />
				- "review-pr-changes"<br />
				- "add-error-handling"<br />
				- "write-api-docs"<br />
				- "optimize-database-query"<br />
				- "migrate-to-typescript"<br />
				<br />
				Return ONLY the JSON object in a markdown code block. Do not include explanations or additional prose.
			</>
		);
	}
}
