/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';

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
 * Checks if Anthropic context editing is enabled.
 * This requires both the Messages API to be enabled and context editing to be enabled.
 * @param configurationService The configuration service
 * @param experimentationService The experimentation service
 * @returns true if Anthropic context editing is enabled
 */
export function isAnthropicContextEditingEnabled(
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService
): boolean {
	const useMessagesApi = configurationService.getExperimentBasedConfig(ConfigKey.UseAnthropicMessagesApi, experimentationService);
	const contextEditingEnabled = configurationService.getConfig(ConfigKey.AnthropicContextEditingEnabled);
	return !!(useMessagesApi && contextEditingEnabled);
}

export interface ContextEditingConfig {
	triggerType: 'input_tokens' | 'tool_uses';
	triggerValue: number;
	keepCount: number;
	clearAtLeastTokens: number | undefined;
	excludeTools: string[];
	clearInputs: boolean;
	thinkingKeepTurns: number;
}

/**
 * Builds the context_management configuration object for the Messages API request.
 * @param config The context editing configuration from individual settings
 * @param hasThinking Whether extended thinking is enabled (the thinking budget value)
 * @param modelMaxTokens The maximum input tokens supported by the model
 * @returns The context_management object to include in the request, or undefined if no edits
 */
export function buildContextManagement(
	config: ContextEditingConfig,
	hasThinking: number | undefined,
	modelMaxTokens: number
): ContextManagement | undefined {
	const edits: ContextManagementEdit[] = [];

	// Add thinking block clearing if extended thinking is enabled
	if (hasThinking) {
		const thinkingKeepTurns = config.thinkingKeepTurns;
		edits.push({
			type: 'clear_thinking_20251015',
			keep: { type: 'thinking_turns', value: Math.max(1, thinkingKeepTurns) },
		});
	}

	// Add tool result clearing configuration
	const { triggerType, triggerValue, keepCount, clearAtLeastTokens, excludeTools, clearInputs } = config;

	// Build trigger based on type - use configured values directly (defaults match Anthropic's recommendations)
	const trigger: ContextManagementTrigger = { type: triggerType, value: triggerValue };

	const toolEdit: ContextManagementEdit = {
		type: 'clear_tool_uses_20250919',
		trigger,
		keep: { type: 'tool_uses', value: keepCount },
		...(clearAtLeastTokens ? { clear_at_least: { type: 'input_tokens' as const, value: clearAtLeastTokens } } : {}),
		...(excludeTools.length > 0 ? { exclude_tools: excludeTools } : {}),
		...(clearInputs ? { clear_tool_inputs: clearInputs } : {}),
	};
	edits.push(toolEdit);

	return edits.length > 0 ? { edits } : undefined;
}

/**
 * Reads context editing configuration from settings and builds the context_management object.
 * This is a convenience function that combines reading configuration with buildContextManagement.
 * @param configurationService The configuration service to read settings from
 * @param experimentationService The experimentation service for experiment-based config
 * @param thinkingBudget The thinking budget value (undefined if thinking is disabled)
 * @param modelMaxInputTokens The maximum input tokens supported by the model
 * @returns The context_management object to include in the request, or undefined if disabled
 */
export function getContextManagementFromConfig(
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
	thinkingBudget: number | undefined,
	modelMaxInputTokens: number
): ContextManagement | undefined {
	const contextEditingEnabled = configurationService.getConfig(ConfigKey.AnthropicContextEditingEnabled);
	if (!contextEditingEnabled) {
		return undefined;
	}

	const contextEditingConfig: ContextEditingConfig = {
		triggerType: (experimentationService.getTreatmentVariable<string>('copilotchat.anthropic.contextEditing.toolResult.triggerType') ?? 'input_tokens') as 'input_tokens' | 'tool_uses',
		triggerValue: experimentationService.getTreatmentVariable<number>('copilotchat.anthropic.contextEditing.toolResult.triggerValue') ?? 75000,
		keepCount: experimentationService.getTreatmentVariable<number>('copilotchat.anthropic.contextEditing.toolResult.keepCount') ?? 5,
		clearAtLeastTokens: experimentationService.getTreatmentVariable<number>('copilotchat.anthropic.contextEditing.toolResult.clearAtLeastTokens') ?? 5000,
		excludeTools: [],
		clearInputs: experimentationService.getTreatmentVariable<boolean>('copilotchat.anthropic.contextEditing.toolResult.clearInputs') ?? true,
		thinkingKeepTurns: experimentationService.getTreatmentVariable<number>('copilotchat.anthropic.contextEditing.thinking.keepTurns') ?? 1,
	};

	return buildContextManagement(contextEditingConfig, thinkingBudget, modelMaxInputTokens);
}
