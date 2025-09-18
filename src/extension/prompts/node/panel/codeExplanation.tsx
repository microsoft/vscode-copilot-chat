/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import type { ChatDiffHunk } from 'vscode';
import { Turn } from '../../../prompt/common/conversation';
import { InstructionMessage } from '../base/instructionMessage';
import { ResponseTranslationRules } from '../base/responseTranslationRules';
import { SafetyRules } from '../base/safetyRules';
import { HistoryWithInstructions } from './conversationHistory';

export interface CodeExplanationPromptProps extends BasePromptElementProps {
	history: readonly Turn[];
	diffHunks: readonly ChatDiffHunk[];
}

export class CodeExplanationPrompt extends PromptElement<CodeExplanationPromptProps> {
	override render() {
		return (
			<>
				<SystemMessage priority={1000}>
					You are an expert at explaining code changes in a clear and concise manner. You will be presented with a chat conversation and specific code diff hunks that were generated during editing. For each diff hunk, provide a brief explanation of what changed and why it's significant.<br />
					<SafetyRules />
				</SystemMessage>
				<HistoryWithInstructions historyPriority={800} passPriority history={this.props.history}>
					<InstructionMessage priority={1000}>
						<ResponseTranslationRules />
						For each diff hunk provided, you should return a JSON array with explanations. Each explanation should have:<br />
						- hunkId: The ID of the diff hunk being explained<br />
						- explanation: A brief, clear explanation of the change (1-2 sentences)<br />
						- title (optional): A short title for the change<br />
						- severity (optional): 'info', 'warning', or 'error' if applicable<br />
						<br />
						Focus on:<br />
						- What the code change accomplishes<br />
						- Why the change was necessary or beneficial<br />
						- Any potential impact or important considerations<br />
						<br />
						Keep explanations concise but informative.
					</InstructionMessage>
				</HistoryWithInstructions>
				<UserMessage priority={900}>
					Please explain the following code diff hunks:<br />
					<br />
					{this.props.diffHunks.map((hunk, index) => (
						<>
							**Diff Hunk {index + 1} (ID: {hunk.hunkId})**<br />
							File: {hunk.uri.toString()}<br />
							Language: {hunk.language}<br />
							Lines {hunk.originalStartLine}-{hunk.originalEndLine} → {hunk.modifiedStartLine}-{hunk.modifiedEndLine}<br />
							<br />
							Original code:<br />
							```{hunk.language}<br />
							{hunk.originalText}<br />
							```<br />
							<br />
							Modified code:<br />
							```{hunk.language}<br />
							{hunk.modifiedText}<br />
							```<br />
							<br />
						</>
					))}
					<br />
					Return a JSON array of explanations for each diff hunk.
				</UserMessage>
			</>);
	}
}
