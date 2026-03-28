/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ATTR_GEN_AI_AGENT_DESCRIPTION,
	ATTR_GEN_AI_AGENT_ID,
	ATTR_GEN_AI_AGENT_NAME,
	ATTR_GEN_AI_CONVERSATION_ID,
	ATTR_GEN_AI_INPUT_MESSAGES,
	ATTR_GEN_AI_OPERATION_NAME,
	ATTR_GEN_AI_OUTPUT_MESSAGES,
	ATTR_GEN_AI_OUTPUT_TYPE,
	ATTR_GEN_AI_PROVIDER_NAME,
	ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
	ATTR_GEN_AI_REQUEST_MAX_TOKENS,
	ATTR_GEN_AI_REQUEST_MODEL,
	ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
	ATTR_GEN_AI_REQUEST_SEED,
	ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
	ATTR_GEN_AI_REQUEST_TEMPERATURE,
	ATTR_GEN_AI_REQUEST_TOP_P,
	ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
	ATTR_GEN_AI_RESPONSE_ID,
	ATTR_GEN_AI_RESPONSE_MODEL,
	ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
	ATTR_GEN_AI_TOKEN_TYPE,
	ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
	ATTR_GEN_AI_TOOL_CALL_ID,
	ATTR_GEN_AI_TOOL_CALL_RESULT,
	ATTR_GEN_AI_TOOL_DEFINITIONS,
	ATTR_GEN_AI_TOOL_DESCRIPTION,
	ATTR_GEN_AI_TOOL_NAME,
	ATTR_GEN_AI_TOOL_TYPE,
	ATTR_GEN_AI_USAGE_INPUT_TOKENS,
	ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
	GEN_AI_OPERATION_NAME_VALUE_CHAT,
	GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
	GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
	GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
	GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
	GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
	GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
	GEN_AI_TOKEN_TYPE_VALUE_INPUT,
	GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
} from '@opentelemetry/semantic-conventions/incubating';
import {
	ATTR_ERROR_TYPE,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
} from '@opentelemetry/semantic-conventions';

// gen_ai.operation.name values
export const GenAiOperationName = {
	CHAT: GEN_AI_OPERATION_NAME_VALUE_CHAT,
	INVOKE_AGENT: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
	EXECUTE_TOOL: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
	EMBEDDINGS: GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
	/** Extension-specific: standalone markdown content event */
	CONTENT_EVENT: 'content_event',
	/** Extension-specific: hook command execution */
	EXECUTE_HOOK: 'execute_hook',
} as const;

// gen_ai.provider.name values
export const GenAiProviderName = {
	/** Extension-specific: GitHub as a provider */
	GITHUB: 'github',
	OPENAI: GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
	ANTHROPIC: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
	AZURE_AI_OPENAI: GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
} as const;

// gen_ai.token.type values
export const GenAiTokenType = {
	INPUT: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
	OUTPUT: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
} as const;

// gen_ai.tool.type values
export const GenAiToolType = {
	FUNCTION: 'function',
	/** Extension-specific: VS Code extension tool */
	EXTENSION: 'extension',
} as const;

/**
 * OTel GenAI semantic convention attribute keys.
 * Uses constants from `@opentelemetry/semantic-conventions/incubating` where available.
 * @see https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
 */
export const GenAiAttr = {
	// Core
	OPERATION_NAME: ATTR_GEN_AI_OPERATION_NAME,
	PROVIDER_NAME: ATTR_GEN_AI_PROVIDER_NAME,

	// Request
	REQUEST_MODEL: ATTR_GEN_AI_REQUEST_MODEL,
	REQUEST_TEMPERATURE: ATTR_GEN_AI_REQUEST_TEMPERATURE,
	REQUEST_MAX_TOKENS: ATTR_GEN_AI_REQUEST_MAX_TOKENS,
	REQUEST_TOP_P: ATTR_GEN_AI_REQUEST_TOP_P,
	REQUEST_FREQUENCY_PENALTY: ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
	REQUEST_PRESENCE_PENALTY: ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
	REQUEST_SEED: ATTR_GEN_AI_REQUEST_SEED,
	REQUEST_STOP_SEQUENCES: ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,

	// Response
	RESPONSE_MODEL: ATTR_GEN_AI_RESPONSE_MODEL,
	RESPONSE_ID: ATTR_GEN_AI_RESPONSE_ID,
	RESPONSE_FINISH_REASONS: ATTR_GEN_AI_RESPONSE_FINISH_REASONS,

	// Usage
	USAGE_INPUT_TOKENS: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
	USAGE_OUTPUT_TOKENS: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
	/** Custom: not yet standardized in OTel GenAI conventions */
	USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
	/** Custom: not yet standardized in OTel GenAI conventions */
	USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
	/** Custom: reasoning/thinking token count (not yet standardized in GenAI conventions) */
	USAGE_REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',

	// Conversation
	CONVERSATION_ID: ATTR_GEN_AI_CONVERSATION_ID,
	OUTPUT_TYPE: ATTR_GEN_AI_OUTPUT_TYPE,

	// Token type (for metrics)
	TOKEN_TYPE: ATTR_GEN_AI_TOKEN_TYPE,

	// Agent
	AGENT_NAME: ATTR_GEN_AI_AGENT_NAME,
	AGENT_ID: ATTR_GEN_AI_AGENT_ID,
	/** Custom: not yet standardized in OTel GenAI conventions */
	AGENT_VERSION: 'gen_ai.agent.version',
	AGENT_DESCRIPTION: ATTR_GEN_AI_AGENT_DESCRIPTION,

	// Tool
	TOOL_NAME: ATTR_GEN_AI_TOOL_NAME,
	TOOL_TYPE: ATTR_GEN_AI_TOOL_TYPE,
	TOOL_CALL_ID: ATTR_GEN_AI_TOOL_CALL_ID,
	TOOL_DESCRIPTION: ATTR_GEN_AI_TOOL_DESCRIPTION,
	TOOL_CALL_ARGUMENTS: ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
	TOOL_CALL_RESULT: ATTR_GEN_AI_TOOL_CALL_RESULT,

	// Content (opt-in)
	INPUT_MESSAGES: ATTR_GEN_AI_INPUT_MESSAGES,
	OUTPUT_MESSAGES: ATTR_GEN_AI_OUTPUT_MESSAGES,
	SYSTEM_INSTRUCTIONS: ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
	TOOL_DEFINITIONS: ATTR_GEN_AI_TOOL_DEFINITIONS,
} as const;

/**
 * Extension-specific attribute keys (custom namespace).
 */
export const CopilotChatAttr = {
	LOCATION: 'copilot_chat.location',
	INTENT: 'copilot_chat.intent',
	TURN_INDEX: 'copilot_chat.turn.index',
	TURN_COUNT: 'copilot_chat.turn_count',
	TOOL_CALL_ROUND: 'copilot_chat.tool_call_round',
	API_TYPE: 'copilot_chat.api_type',
	FETCHER: 'copilot_chat.fetcher',
	DEBUG_NAME: 'copilot_chat.debug_name',
	ENDPOINT_TYPE: 'copilot_chat.endpoint_type',
	MAX_PROMPT_TOKENS: 'copilot_chat.request.max_prompt_tokens',
	TIME_TO_FIRST_TOKEN: 'copilot_chat.time_to_first_token',
	SESSION_ID: 'copilot_chat.session_id',
	SERVER_REQUEST_ID: 'copilot_chat.server_request_id',
	CANCELED: 'copilot_chat.canceled',
	/** Extended thinking/reasoning content (content-gated) */
	REASONING_CONTENT: 'copilot_chat.reasoning_content',
	/** User's actual typed message text, extracted from prompt context */
	USER_REQUEST: 'copilot_chat.user_request',
	/** Resolved context section (code snippets, file contents, etc.) */
	PROMPT_CONTEXT: 'copilot_chat.prompt_context',
	/** Custom instructions section */
	PROMPT_INSTRUCTIONS: 'copilot_chat.prompt_instructions',
	/** VS Code chat session ID from CapturingToken — the definitive session identifier */
	CHAT_SESSION_ID: 'copilot_chat.chat_session_id',
	/** Parent chat session ID for linking child sessions (e.g., title, categorization) to their parent */
	PARENT_CHAT_SESSION_ID: 'copilot_chat.parent_chat_session_id',
	/** Debug log label for child sessions (e.g., 'title', 'categorization', 'runSubagent') */
	DEBUG_LOG_LABEL: 'copilot_chat.debug_log_label',
	/** Markdown content for standalone content events */
	MARKDOWN_CONTENT: 'copilot_chat.markdown_content',
	/** Edit source: inline_chat, chat_editing, chat_editing_hunk */
	EDIT_SOURCE: 'copilot_chat.edit.source',
	/** Edit outcome: accepted, rejected, saved, unknown */
	EDIT_OUTCOME: 'copilot_chat.edit.outcome',
	/** Language identifier of the document */
	LANGUAGE_ID: 'copilot_chat.language_id',
	/** Time delay in milliseconds between acceptance and measurement */
	TIME_DELAY_MS: 'copilot_chat.time_delay_ms',
	/** Whether additional unactioned edits remain */
	HAS_REMAINING_EDITS: 'copilot_chat.has_remaining_edits',
} as const;

export type EditSource = 'inline_chat' | 'chat_editing' | 'chat_editing_hunk';
export type EditOutcome = 'accepted' | 'rejected' | 'saved' | 'unknown';

/**
 * Standard OTel attributes used alongside GenAI attributes.
 * Uses constants from `@opentelemetry/semantic-conventions`.
 */
export const StdAttr = {
	ERROR_TYPE: ATTR_ERROR_TYPE,
	SERVER_ADDRESS: ATTR_SERVER_ADDRESS,
	SERVER_PORT: ATTR_SERVER_PORT,
} as const;
