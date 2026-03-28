/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as OTelSemConv from '@opentelemetry/semantic-conventions/incubating';

// gen_ai.operation.name values
export const GenAiOperationName = {
	CHAT: OTelSemConv.GEN_AI_OPERATION_NAME_VALUE_CHAT,
	INVOKE_AGENT: OTelSemConv.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
	EXECUTE_TOOL: OTelSemConv.GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
	EMBEDDINGS: OTelSemConv.GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
	/** Extension-specific: standalone markdown content event */
	CONTENT_EVENT: 'content_event',
	/** Extension-specific: hook command execution */
	EXECUTE_HOOK: 'execute_hook',
} as const;

// gen_ai.provider.name values
export const GenAiProviderName = {
	/** Extension-specific: GitHub as a provider */
	GITHUB: 'github',
	OPENAI: OTelSemConv.GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
	ANTHROPIC: OTelSemConv.GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
	AZURE_AI_OPENAI: OTelSemConv.GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
} as const;

// gen_ai.token.type values
export const GenAiTokenType = {
	INPUT: OTelSemConv.GEN_AI_TOKEN_TYPE_VALUE_INPUT,
	OUTPUT: OTelSemConv.GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
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
	OPERATION_NAME: OTelSemConv.ATTR_GEN_AI_OPERATION_NAME,
	PROVIDER_NAME: OTelSemConv.ATTR_GEN_AI_PROVIDER_NAME,

	// Request
	REQUEST_MODEL: OTelSemConv.ATTR_GEN_AI_REQUEST_MODEL,
	REQUEST_TEMPERATURE: OTelSemConv.ATTR_GEN_AI_REQUEST_TEMPERATURE,
	REQUEST_MAX_TOKENS: OTelSemConv.ATTR_GEN_AI_REQUEST_MAX_TOKENS,
	REQUEST_TOP_P: OTelSemConv.ATTR_GEN_AI_REQUEST_TOP_P,
	REQUEST_FREQUENCY_PENALTY: OTelSemConv.ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
	REQUEST_PRESENCE_PENALTY: OTelSemConv.ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
	REQUEST_SEED: OTelSemConv.ATTR_GEN_AI_REQUEST_SEED,
	REQUEST_STOP_SEQUENCES: OTelSemConv.ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,

	// Response
	RESPONSE_MODEL: OTelSemConv.ATTR_GEN_AI_RESPONSE_MODEL,
	RESPONSE_ID: OTelSemConv.ATTR_GEN_AI_RESPONSE_ID,
	RESPONSE_FINISH_REASONS: OTelSemConv.ATTR_GEN_AI_RESPONSE_FINISH_REASONS,

	// Usage
	USAGE_INPUT_TOKENS: OTelSemConv.ATTR_GEN_AI_USAGE_INPUT_TOKENS,
	USAGE_OUTPUT_TOKENS: OTelSemConv.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
	USAGE_CACHE_READ_INPUT_TOKENS: OTelSemConv.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
	USAGE_CACHE_CREATION_INPUT_TOKENS: OTelSemConv.ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
	/** Custom: reasoning/thinking token count (not yet standardized in GenAI conventions) */
	USAGE_REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',

	// Conversation
	CONVERSATION_ID: OTelSemConv.ATTR_GEN_AI_CONVERSATION_ID,
	OUTPUT_TYPE: OTelSemConv.ATTR_GEN_AI_OUTPUT_TYPE,

	// Token type (for metrics)
	TOKEN_TYPE: OTelSemConv.ATTR_GEN_AI_TOKEN_TYPE,

	// Agent
	AGENT_NAME: OTelSemConv.ATTR_GEN_AI_AGENT_NAME,
	AGENT_ID: OTelSemConv.ATTR_GEN_AI_AGENT_ID,
	AGENT_VERSION: OTelSemConv.ATTR_GEN_AI_AGENT_VERSION,
	AGENT_DESCRIPTION: OTelSemConv.ATTR_GEN_AI_AGENT_DESCRIPTION,

	// Tool
	TOOL_NAME: OTelSemConv.ATTR_GEN_AI_TOOL_NAME,
	TOOL_TYPE: OTelSemConv.ATTR_GEN_AI_TOOL_TYPE,
	TOOL_CALL_ID: OTelSemConv.ATTR_GEN_AI_TOOL_CALL_ID,
	TOOL_DESCRIPTION: OTelSemConv.ATTR_GEN_AI_TOOL_DESCRIPTION,
	TOOL_CALL_ARGUMENTS: OTelSemConv.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
	TOOL_CALL_RESULT: OTelSemConv.ATTR_GEN_AI_TOOL_CALL_RESULT,

	// Content (opt-in)
	INPUT_MESSAGES: OTelSemConv.ATTR_GEN_AI_INPUT_MESSAGES,
	OUTPUT_MESSAGES: OTelSemConv.ATTR_GEN_AI_OUTPUT_MESSAGES,
	SYSTEM_INSTRUCTIONS: OTelSemConv.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
	TOOL_DEFINITIONS: OTelSemConv.ATTR_GEN_AI_TOOL_DEFINITIONS,
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
	ERROR_TYPE: OTelSemConv.ATTR_ERROR_TYPE,
	SERVER_ADDRESS: OTelSemConv.ATTR_SERVER_ADDRESS,
	SERVER_PORT: OTelSemConv.ATTR_SERVER_PORT,
} as const;
