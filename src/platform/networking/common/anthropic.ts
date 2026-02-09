/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { IChatEndpoint } from './networking';

/**
 * Types for Anthropic Messages API
 * Based on https://platform.claude.com/docs/en/api/messages
 *
 * This interface supports both regular tools and server tools (web search, tool search):
 * - Regular tools: require name, description, and input_schema
 * - Tool search tools: require only type and name
 */
export interface AnthropicMessagesTool {
	name: string;
	type?: string;
	description?: string;
	input_schema?: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
	};
	defer_loading?: boolean;
}

export interface ToolReference {
	type: 'tool_reference';
	tool_name: string;
}

export interface ToolSearchToolSearchResult {
	type: 'tool_search_tool_search_result';
	tool_references: ToolReference[];
}

export interface ToolSearchToolResultError {
	type: 'tool_search_tool_result_error';
	error_code: 'too_many_requests' | 'invalid_pattern' | 'pattern_too_long' | 'unavailable';
}

export interface ServerToolUse {
	type: 'server_tool_use';
	id: string;
	name: string;
	input: {
		query: string;
	};
}

export interface ToolSearchToolResult {
	type: 'tool_search_tool_result';
	tool_use_id: string;
	content: ToolSearchToolSearchResult | ToolSearchToolResultError;
}

export interface ToolSearchUsage {
	tool_search_requests: number;
}

/**
 * Tools that should not use deferred loading when tool search is enabled.
 * These are frequently used tools that benefit from being immediately available.
 *
 * TODO: @bhavyaus Replace these hardcoded strings with constants from ToolName enum
 */
export const nonDeferredToolNames = new Set([
	// Read/navigate
	'read_file',
	'list_dir',
	// Search
	'grep_search',
	'semantic_search',
	'file_search',
	// Edit
	'replace_string_in_file',
	'multi_replace_string_in_file',
	'insert_edit_into_file',
	'apply_patch',
	'create_file',
	// Terminal
	'run_in_terminal',
	'get_terminal_output',
	// Other high-usage tools
	'get_errors',
	'manage_todo_list',
	// Subagent tools
	'runSubagent',
	'search_subagent',
	// Testing
	'runTests',
	// Misc
	'ask_questions',
	'switch_agent',
]);

export const TOOL_SEARCH_TOOL_NAME = 'tool_search_tool_regex';
export const TOOL_SEARCH_TOOL_TYPE = 'tool_search_tool_regex_20251119';

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
 * Context editing is supported by:
 * - Claude Haiku 4.5 (claude-haiku-4-5-* or claude-haiku-4.5-*)
 * - Claude Sonnet 4.5 (claude-sonnet-4-5-* or claude-sonnet-4.5-*)
 * - Claude Sonnet 4 (claude-sonnet-4-*)
 * - Claude Opus 4.6 (claude-opus-4-6-* or claude-opus-4.6-*)
 * - Claude Opus 4.5 (claude-opus-4-5-* or claude-opus-4.5-*)
 * - Claude Opus 4.1 (claude-opus-4-1-* or claude-opus-4.1-*)
 * - Claude Opus 4 (claude-opus-4-*)
 * @param modelId The model ID to check
 * @returns true if the model supports context editing
 */
export function modelSupportsContextEditing(modelId: string): boolean {
	// Normalize: lowercase and replace dots with dashes so "4.5" matches "4-5"
	const normalized = modelId.toLowerCase().replace(/\./g, '-');
	return normalized.startsWith('claude-haiku-4-5') ||
		normalized.startsWith('claude-sonnet-4-5') ||
		normalized.startsWith('claude-sonnet-4') ||
		normalized.startsWith('claude-opus-4-6') ||
		normalized.startsWith('claude-opus-4-5') ||
		normalized.startsWith('claude-opus-4-1') ||
		normalized.startsWith('claude-opus-4');
}

/**
 * Tool search is supported by:
 * - Claude Opus 4.6 (claude-opus-4-6-* or claude-opus-4.6-*)
 * - Claude Opus 4.5 (claude-opus-4-5-* or claude-opus-4.5-*)
 * @param modelId The model ID to check
 * @returns true if the model supports tool search
 */
export function modelSupportsToolSearch(modelId: string): boolean {
	// Normalize: lowercase and replace dots with dashes so "4.5" matches "4-5"
	const normalized = modelId.toLowerCase().replace(/\./g, '-');
	// TODO: Enable sonnet tool search when supported by all providers
	// return normalized.startsWith('claude-sonnet-4-5') ||
	return normalized.startsWith('claude-opus-4-6') ||
		normalized.startsWith('claude-opus-4-5');
}

/**
 * Interleaved thinking is supported by:
 * - Claude Sonnet 4.5 (claude-sonnet-4-5-* or claude-sonnet-4.5-*)
 * - Claude Sonnet 4 (claude-sonnet-4-*)
 * - Claude Haiku 4.5 (claude-haiku-4-5-* or claude-haiku-4.5-*)
 * - Claude Opus 4.5 (claude-opus-4-5-* or claude-opus-4.5-*)
 * @param modelId The model ID to check
 * @returns true if the model supports interleaved thinking
 */
export function modelSupportsInterleavedThinking(modelId: string): boolean {
	// Normalize: lowercase and replace dots with dashes so "4.5" matches "4-5"
	const normalized = modelId.toLowerCase().replace(/\./g, '-');
	return normalized.startsWith('claude-sonnet-4-5') ||
		normalized.startsWith('claude-sonnet-4') ||
		normalized.startsWith('claude-haiku-4-5') ||
		normalized.startsWith('claude-opus-4-5');
}

/**
 * Memory is supported by:
 * - Claude Haiku 4.5 (claude-haiku-4-5-* or claude-haiku-4.5-*)
 * - Claude Sonnet 4.5 (claude-sonnet-4-5-* or claude-sonnet-4.5-*)
 * - Claude Sonnet 4 (claude-sonnet-4-*)
 * - Claude Opus 4.6 (claude-opus-4-6-* or claude-opus-4.6-*)
 * - Claude Opus 4.5 (claude-opus-4-5-* or claude-opus-4.5-*)
 * - Claude Opus 4.1 (claude-opus-4-1-* or claude-opus-4.1-*)
 * - Claude Opus 4 (claude-opus-4-*)
 * @param modelId The model ID to check
 * @returns true if the model supports memory
 */
export function modelSupportsMemory(modelId: string): boolean {
	const normalized = modelId.toLowerCase().replace(/\./g, '-');
	return normalized.startsWith('claude-haiku-4-5') ||
		normalized.startsWith('claude-sonnet-4-5') ||
		normalized.startsWith('claude-sonnet-4') ||
		normalized.startsWith('claude-opus-4-6') ||
		normalized.startsWith('claude-opus-4-5') ||
		normalized.startsWith('claude-opus-4-1') ||
		normalized.startsWith('claude-opus-4');
}

export function isAnthropicToolSearchEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
): boolean {

	const effectiveModelId = typeof endpoint === 'string' ? endpoint : endpoint.model;
	if (!modelSupportsToolSearch(effectiveModelId)) {
		return false;
	}

	return configurationService.getExperimentBasedConfig(ConfigKey.AnthropicToolSearchEnabled, experimentationService);
}

export function isAnthropicContextEditingEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
): boolean {

	const effectiveModelId = typeof endpoint === 'string' ? endpoint : endpoint.model;
	if (!modelSupportsContextEditing(effectiveModelId)) {
		return false;
	}
	return configurationService.getExperimentBasedConfig(ConfigKey.AnthropicContextEditingEnabled, experimentationService);
}

export function isAnthropicMemoryToolEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
): boolean {
	const effectiveModelId = typeof endpoint === 'string' ? endpoint : endpoint.model;
	if (!modelSupportsMemory(effectiveModelId)) {
		return false;
	}
	return configurationService.getExperimentBasedConfig(ConfigKey.MemoryToolEnabled, experimentationService);
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
 * @param thinkingEnabled Whether extended thinking is enabled
 * @returns The context_management object to include in the request, or undefined if no edits
 */
export function buildContextManagement(
	config: ContextEditingConfig,
	thinkingEnabled: boolean
): ContextManagement | undefined {
	const edits: ContextManagementEdit[] = [];

	// Add thinking block clearing if extended thinking is enabled
	if (thinkingEnabled) {
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
 * @param thinkingEnabled Whether extended thinking is enabled
 * @returns The context_management object to include in the request, or undefined if disabled
 */
export function getContextManagementFromConfig(
	configurationService: IConfigurationService,
	thinkingEnabled: boolean,
): ContextManagement | undefined {

	const userConfig = configurationService.getConfig(ConfigKey.Advanced.AnthropicContextEditingConfig);

	const contextEditingConfig: ContextEditingConfig = {
		triggerType: userConfig?.triggerType ?? 'input_tokens',
		triggerValue: userConfig?.triggerValue ?? 100000,
		keepCount: userConfig?.keepCount ?? 3,
		clearAtLeastTokens: userConfig?.clearAtLeastTokens,
		excludeTools: userConfig?.excludeTools ?? [],
		clearInputs: userConfig?.clearInputs ?? false,
		thinkingKeepTurns: userConfig?.thinkingKeepTurns ?? 1,
	};

	return buildContextManagement(contextEditingConfig, thinkingEnabled);
}
