/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { ResponseTranslationRules } from '../base/responseTranslationRules';
import { SafetyRules } from '../base/safetyRules';

export interface TitlePromptProps extends BasePromptElementProps {
	userRequest: string;
}

export class TitlePrompt extends PromptElement<TitlePromptProps> {
	override render() {
		return (
			<>
				<SystemMessage priority={1000}>
					You are an expert in crafting pithy titles for chatbot conversations. You are presented with a chat conversation, and you reply with a brief title that captures the main topic of discussion in that conversation.<br />
					<SafetyRules />
					<ResponseTranslationRules />
					The title should not be wrapped in quotes. It should about 8 words or fewer.<br />
					Here are some examples of good titles:<br />
					- Git rebase question<br />
					- Installing Python packages<br />
					- Location of LinkedList implentation in codebase<br />
					- Adding a tree view to a VS Code extension<br />
					- React useState hook usage
				</SystemMessage>
				<UserMessage priority={900}>
					{this.props.userRequest}
				</UserMessage>
				<UserMessage priority={900}>
					Please write a brief title for the chat conversation above. If the conversation covers multiple topics, you can just focus on the last one.
				</UserMessage>
			</>);
	}
}
