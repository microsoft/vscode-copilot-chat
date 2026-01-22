/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { ResponseTranslationRules } from '../base/responseTranslationRules';
import { SafetyRules } from '../base/safetyRules';

export type ProgressMessageScenario = 'generate' | 'edit';

export interface ProgressMessagesPromptProps extends BasePromptElementProps {
	readonly scenario: ProgressMessageScenario;
	readonly count: number;
}

export class ProgressMessagesPrompt extends PromptElement<ProgressMessagesPromptProps> {
	override render() {
		const scenarioDescription = this.props.scenario === 'generate'
			? 'generating new code from scratch based on a user request'
			: 'editing and improving existing code based on a user request';

		return (
			<>
				<SystemMessage priority={1000}>
					You are an expert in writing short, catchy, and encouraging progress messages for a coding assistant.<br />
					The messages are shown to users while they wait for an AI to {scenarioDescription}.<br />
					<br />
					<SafetyRules />
					<ResponseTranslationRules />
					<br />
					Guidelines for the messages:<br />
					- Each message should be 2-4 words<br />
					- Be encouraging and slightly playful<br />
					- Reference coding/programming themes<br />
					- Avoid technical jargon that would confuse beginners<br />
					- Do not use emojis<br />
					- Do not use punctuation at the end<br />
					- Each message should be unique and different from the others<br />
					- Return messages as a JSON array of strings, nothing else<br />
					<br />
					Examples of good progress messages:<br />
					- Warming up the algorithms<br />
					- Brewing some fresh code<br />
					- Crafting your solution<br />
					- Thinking through the logic<br />
					- Almost there, hang tight<br />
				</SystemMessage>
				<UserMessage priority={900}>
					Please generate exactly {this.props.count} unique progress messages for the "{this.props.scenario} code" scenario.<br />
					Return only a JSON array of strings, no other text.
				</UserMessage>
			</>
		);
	}
}
