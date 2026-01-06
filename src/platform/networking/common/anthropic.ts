/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types for Anthropic Messages API
 * Based on https://platform.claude.com/docs/en/api/messages
 */

export interface AnthropicMessagesTool {
	name: string;
	description?: string;
	input_schema: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * Context management types for Anthropic Messages API
 * Based on https://platform.claude.com/docs/en/build-with-claude/context-editing
 */

export type ContextManagementTrigger =
	| { type: 'input_tokens'; value: number }
	| { type: 'tool_uses'; value: number };

export type ContextManagementKeep =
	| { type: 'tool_uses'; value: number }
	| { type: 'thinking_turns'; value: number }
	| 'all';

export type ContextManagementClearAtLeast = {
	type: 'input_tokens';
	value: number;
};

export interface ClearToolUsesEdit {
	type: 'clear_tool_uses_20250919';
	trigger?: ContextManagementTrigger;
	keep?: ContextManagementKeep;
	clear_at_least?: ContextManagementClearAtLeast;
	exclude_tools?: string[];
	clear_tool_inputs?: boolean;
}

export interface ClearThinkingEdit {
	type: 'clear_thinking_20251015';
	keep?: ContextManagementKeep;
}

export type ContextManagementEdit = ClearToolUsesEdit | ClearThinkingEdit;

export interface ContextManagement {
	edits: ContextManagementEdit[];
}

export interface AppliedContextEdit {
	type: 'clear_thinking_20251015' | 'clear_tool_uses_20250919';
	cleared_thinking_turns?: number;
	cleared_tool_uses?: number;
	cleared_input_tokens?: number;
}

export interface ContextManagementResponse {
	applied_edits: AppliedContextEdit[];
}

/**
 * Builds the context_management configuration object for the Messages API request.
 * @param config The context editing configuration from settings
 * @param hasThinking Whether extended thinking is enabled (the thinking budget value)
 * @param modelMaxTokens The maximum input tokens supported by the model
 * @returns The context_management object to include in the request, or undefined if no edits
 */
export function buildContextManagement(
	config: {
		toolResult: {
			triggerTokens: number;
			keepCount: number;
			clearAtLeastTokens?: number;
			excludeTools: string[];
			clearInputs: boolean;
		};
		thinking: {
			keepTurns: number;
		};
	},
	hasThinking: number | undefined,
	modelMaxTokens: number
): ContextManagement | undefined {
	const edits: ContextManagementEdit[] = [];

	// Add thinking block clearing if extended thinking is enabled
	if (hasThinking) {
		const thinkingKeepTurns = config.thinking.keepTurns;
		edits.push({
			type: 'clear_thinking_20251015',
			keep: thinkingKeepTurns > 0 ? { type: 'thinking_turns', value: thinkingKeepTurns } : { type: 'thinking_turns', value: 1 },
		});
	}

	// Add tool result clearing configuration
	const { triggerTokens, keepCount, clearAtLeastTokens, excludeTools, clearInputs } = config.toolResult;

	// Calculate trigger tokens: use configured value if set, otherwise calculate as 90% of model max tokens
	const calculatedTriggerTokens = triggerTokens > 0 ? triggerTokens : Math.floor(modelMaxTokens * 0.9);

	const toolEdit: ContextManagementEdit = {
		type: 'clear_tool_uses_20250919',
		trigger: { type: 'input_tokens', value: calculatedTriggerTokens },
		keep: { type: 'tool_uses', value: keepCount },
		...(clearAtLeastTokens ? { clear_at_least: { type: 'input_tokens' as const, value: clearAtLeastTokens } } : {}),
		...(excludeTools.length > 0 ? { exclude_tools: excludeTools } : {}),
		...(clearInputs ? { clear_tool_inputs: clearInputs } : {}),
	};
	edits.push(toolEdit);

	return edits.length > 0 ? { edits } : undefined;
}
