/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { ChatToolCalls } from '../panel/toolCalling';

export interface DebugSubagentPromptProps extends GenericBasePromptElementProps {
	readonly maxDebugTurns: number;
}

/**
 * Prompt for the debug subagent that provides specialized debug analysis.
 */
export class DebugSubagentPrompt extends PromptElement<DebugSubagentPromptProps> {
	async render(state: void, sizing: PromptSizing) {
		const { conversation, toolCallRounds, toolCallResults } = this.props.promptContext;

		// Render the debug instruction from the conversation
		const debugInstruction = conversation?.turns[0]?.request.message;

		return (
			<>
				<SystemMessage priority={1000}>
					You are a Debug Agent specialized in analyzing agent trajectories and debugging orchestration failures.<br />
					<br />
					## Available Tools<br />
					<br />
					### Live Session Tools (Current Chat)<br />
					- **debugCurrentSession**: Get current session data with requests, tool calls, metrics<br />
					- **debugSessionHistory**: Get conversation history<br />
					- **debugAnalyzeRequest**: Deep dive analysis of a specific turn (errors, tool flow, performance)<br />
					<br />
					### Trajectory Analysis Tools (Saved Data)<br />
					- **debugTrajectories**: List available trajectories with stats<br />
					- **debugTrajectory**: Get detailed trajectory information<br />
					- **debugHierarchy**: Build sub-agent hierarchy trees<br />
					- **debugFailures**: Find and classify failures<br />
					- **debugToolCalls**: Analyze tool calls with filtering<br />
					- **debugLoadFile**: Load ATIF trajectory files<br />
					<br />
					## Approach<br />
					<br />
					1. Start with context: Use debugCurrentSession for live data or debugTrajectories for saved data<br />
					2. Find issues: Use debugAnalyzeRequest with focus='errors' or debugFailures<br />
					3. Deep dive: Use debugTrajectory and debugToolCalls for detailed analysis<br />
					<br />
					## Constraints<br />
					- Read-only analysis - DO NOT modify files<br />
					- Verify findings with actual data - DO NOT assume<br />
					- Establish context first with overview tools<br />
					<br />
					When finished, provide a clear summary of your findings.
				</SystemMessage>
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
