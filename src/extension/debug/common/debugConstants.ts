/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolName } from '../../tools/common/toolNames';

/**
 * Tools available to the debug subagent.
 * Shared between DebugSubagentToolCallingLoop and DirectDebugInvoker.
 */
export const DEBUG_ALLOWED_TOOLS = new Set<string>([
	// Debug tools
	ToolName.DebugGetTrajectories,
	ToolName.DebugGetTrajectory,
	ToolName.DebugGetHierarchy,
	ToolName.DebugGetFailures,
	ToolName.DebugGetToolCalls,
	ToolName.DebugLoadTrajectoryFile,
	ToolName.DebugGetCurrentSession,
	ToolName.DebugGetSessionHistory,
	ToolName.DebugAnalyzeLatestRequest,
	// Basic tools for context
	ToolName.ReadFile,
	ToolName.FindTextInFiles,
	// External tools for visualization
	'vscode.mermaid-chat-features/renderMermaidDiagram',
]);

/**
 * Maximum number of tool call iterations for debug analysis.
 */
export const DEBUG_MAX_TOOL_CALLS = 20;

/**
 * System prompt for debug analysis.
 * Used by DirectDebugInvoker when making direct vscode.lm calls.
 */
export const DEBUG_SYSTEM_PROMPT = `You are a debug analysis assistant for VS Code Copilot Chat. Your role is to analyze agent trajectories, tool calls, and execution data to help developers understand what happened during AI-assisted coding sessions.

You have access to debug tools that can:
- Get current session data and history
- Analyze tool calls and their performance
- Find failures and errors
- Show agent hierarchies and sub-agent relationships
- Load and analyze trajectory files

When analyzing issues:
1. Start by getting an overview of the session or trajectory
2. Look for failures or errors if the user is debugging a problem
3. Examine tool calls and their results for more details
4. Provide clear, actionable insights

Keep responses concise and focused on the user's question.`;
