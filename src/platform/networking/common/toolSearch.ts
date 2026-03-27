/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { IChatEndpoint } from './networking';

/** Name for the custom client-side embeddings-based tool search tool. Must not use copilot_/vscode_ prefix — those are reserved for static package.json declarations and will be rejected by vscode.lm.registerToolDefinition. */
export const CUSTOM_TOOL_SEARCH_NAME = 'tool_search';

/**
 * Tools that should not use deferred loading when tool search is enabled.
 * These are frequently used tools that benefit from being immediately available.
 * Shared across all API backends (Messages API, Responses API).
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
	'execution_subagent',
	// Testing
	'runTests',
	// Misc
	'ask_questions',
	'switch_agent',
	'memory',
	'task_complete',
	// Custom tool search (must always be available so the model can search for deferred tools)
	CUSTOM_TOOL_SEARCH_NAME,
	'view_image',
	'fetch_webpage'
]);

// ── Anthropic-specific constants ──────────────────────────────────────

export const TOOL_SEARCH_TOOL_NAME = 'tool_search_tool_regex';
export const TOOL_SEARCH_TOOL_TYPE = 'tool_search_tool_regex_20251119';

/** Model ID prefixes that support Anthropic tool search. Used by isAnthropicToolSearchEnabled() and the tool registration's model selector. */
export const ANTHROPIC_TOOL_SEARCH_SUPPORTED_MODELS = [
	'claude-sonnet-4.5',
	'claude-sonnet-4.6',
	'claude-opus-4.5',
	'claude-opus-4.6',
] as const;

// ── Responses API (OpenAI) tool search constants ──────────────────────

/** Model ID prefixes that support Responses API tool search. Per OpenAI docs: "Only gpt-5.4 and later models support tool_search." */
export const RESPONSES_TOOL_SEARCH_SUPPORTED_MODELS = [
	'gpt-5.4',
] as const;

/** All model ID prefixes that support tool search (client-side embeddings). Union of Anthropic + Responses API models. */
export const ALL_TOOL_SEARCH_SUPPORTED_MODELS = [
	...ANTHROPIC_TOOL_SEARCH_SUPPORTED_MODELS,
	...RESPONSES_TOOL_SEARCH_SUPPORTED_MODELS,
] as const;

// ── Anthropic helper functions ────────────────────────────────────────

export function isAnthropicToolSearchEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService
): boolean {
	const effectiveModelId = typeof endpoint === 'string' ? endpoint : endpoint.model;
	if (!ANTHROPIC_TOOL_SEARCH_SUPPORTED_MODELS.some(prefix => effectiveModelId.toLowerCase().startsWith(prefix))) {
		return false;
	}

	return configurationService.getConfig(ConfigKey.AnthropicToolSearchEnabled);
}

/**
 * Returns true when custom client-side embeddings-based tool search should be used
 * instead of the server-side regex tool search.
 */
export function isAnthropicCustomToolSearchEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
): boolean {
	if (!isAnthropicToolSearchEnabled(endpoint, configurationService)) {
		return false;
	}

	return configurationService.getExperimentBasedConfig(ConfigKey.AnthropicToolSearchMode, experimentationService) === 'client';
}

// ── Responses API helper functions ────────────────────────────────────

export function isResponsesApiToolSearchEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
): boolean {
	const effectiveModelId = typeof endpoint === 'string' ? endpoint : endpoint.model;
	if (!RESPONSES_TOOL_SEARCH_SUPPORTED_MODELS.some(prefix => effectiveModelId.toLowerCase().startsWith(prefix))) {
		return false;
	}

	return configurationService.getConfig(ConfigKey.ResponsesApiToolSearchEnabled);
}

/**
 * Returns true when custom client-side embeddings-based tool search should be used
 * instead of the hosted (server-side) tool search for the Responses API.
 */
export function isResponsesApiCustomToolSearchEnabled(
	endpoint: IChatEndpoint | string,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
): boolean {
	if (!isResponsesApiToolSearchEnabled(endpoint, configurationService)) {
		return false;
	}

	return configurationService.getExperimentBasedConfig(ConfigKey.ResponsesApiToolSearchMode, experimentationService) === 'client';
}
