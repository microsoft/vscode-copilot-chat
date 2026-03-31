/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { SafetyRules } from '../base/safetyRules';
import { ChatToolCalls } from '../panel/toolCalling';

export interface SkillSubagentPromptProps extends GenericBasePromptElementProps {
	readonly skillInstructions: string;
	readonly maxTurns: number;
}

/**
 * Prompt for the skill subagent that injects skill-specific instructions
 * as system context and delegates the user's task to the subagent.
 */
export class SkillSubagentPrompt extends PromptElement<SkillSubagentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		const { conversation, toolCallRounds, toolCallResults } = this.props.promptContext;

		const userInstruction = conversation?.turns[0]?.request.message;

		const currentTurn = toolCallRounds?.length ?? 0;
		const isLastTurn = currentTurn >= this.props.maxTurns - 1;

		return (
			<>
				<SystemMessage priority={1000}>
					You are an AI coding assistant with specialized skill instructions loaded as context.<br />
					Follow the skill instructions below carefully to complete the user's task.<br />
					<br />
					<SafetyRules />
					<br />
					{'<skill_instructions>'}<br />
					{this.props.skillInstructions}<br />
					{'</skill_instructions>'}<br />
					<br />
					Once you have finished, return a message with ONLY: the &lt;final_answer&gt; tag to provide a compact summary of what was done.<br />
				</SystemMessage>
				<UserMessage priority={900}>{userInstruction}</UserMessage>
				<ChatToolCalls
					priority={899}
					flexGrow={2}
					promptContext={this.props.promptContext}
					toolCallRounds={toolCallRounds}
					toolCallResults={toolCallResults}
					toolCallMode={CopilotToolMode.FullContext}
				/>
				{isLastTurn && (
					<UserMessage priority={900}>
						OK, your allotted iterations are finished. Show the &lt;final_answer&gt;.
					</UserMessage>
				)}
			</>
		);
	}
}
