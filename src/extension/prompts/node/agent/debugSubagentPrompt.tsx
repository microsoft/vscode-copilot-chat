/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { DEBUG_SYSTEM_PROMPT } from '../../../debug/common/debugConstants';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { ChatToolCalls } from '../panel/toolCalling';

export interface DebugSubagentPromptProps extends GenericBasePromptElementProps {
	readonly maxDebugTurns: number;
}

/**
 * Prompt for the debug subagent that provides specialized debug analysis.
 * Uses shared DEBUG_SYSTEM_PROMPT from debugConstants for consistency
 */
export class DebugSubagentPrompt extends PromptElement<DebugSubagentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		const { conversation, toolCallRounds, toolCallResults } = this.props.promptContext;

		// Render the debug instruction from the conversation
		const debugInstruction = conversation?.turns[0]?.request.message;

		return (
			<>
				<SystemMessage priority={1000}>{DEBUG_SYSTEM_PROMPT}</SystemMessage>
				<UserMessage priority={900}>{debugInstruction}</UserMessage>
				<ChatToolCalls
					priority={899}
					flexGrow={2}
					promptContext={this.props.promptContext}
					toolCallRounds={toolCallRounds}
					toolCallResults={toolCallResults}
					toolCallMode={CopilotToolMode.FullContext}
				/>
			</>
		);
	}
}
