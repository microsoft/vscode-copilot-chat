/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { ChatToolCalls } from '../panel/toolCalling';

/**
 * Prompt for the search subagent that uses custom search instructions
 * instead of the default agent system prompt.
 */
export class SearchSubagentPrompt extends PromptElement<GenericBasePromptElementProps> {
	async render(state: void, sizing: PromptSizing) {
		const { conversation, toolCallRounds, toolCallResults } = this.props.promptContext;

		// Render the search instruction from the conversation
		const searchInstruction = conversation?.turns[0]?.request.message;

		return (
			<>
				<SystemMessage priority={1000}>
					You are an AI coding research assistant that uses search tools to gather information. You can call tools to search for information and read files across a codebase.<br />
					<br />
					You must submit final search results to help the user find what they are looking for. Once you have thoroughly searched the repository, use the &lt;final_answer&gt; tag to provide paths and line ranges of relevant code snippets.<br />
					<br />
					Example:<br />
					<br />
					&lt;final_answer&gt;<br />
					path/to/file.py:10-20<br />
					another_file.cc:100-120<br />
					&lt;final_answer&gt;
				</SystemMessage>
				<UserMessage priority={900}>{searchInstruction}</UserMessage>
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
