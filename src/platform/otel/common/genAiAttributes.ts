/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// gen_ai.operation.name values
export const GenAiOperationName = {
	CHAT: 'chat',
	INVOKE_AGENT: 'invoke_agent',
	EXECUTE_TOOL: 'execute_tool',
	EMBEDDINGS: 'embeddings',
} as const;

// gen_ai.provider.name values
export const GenAiProviderName = {
	OPENAI: 'openai',
	ANTHROPIC: 'anthropic',
	AZURE_AI_OPENAI: 'azure.ai.openai',
} as const;

// gen_ai.token.type values
export const GenAiTokenType = {
	INPUT: 'input',
	OUTPUT: 'output',
} as const;

// gen_ai.tool.type values
export const GenAiToolType = {
	FUNCTION: 'function',
	EXTENSION: 'extension',
} as const;

/**
 * OTel GenAI semantic convention attribute keys.
 * @see https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
 */
export const GenAiAttr = {
	// Core
	OPERATION_NAME: 'gen_ai.operation.name',
	PROVIDER_NAME: 'gen_ai.provider.name',

	// Request
	REQUEST_MODEL: 'gen_ai.request.model',
	REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
	REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
	REQUEST_TOP_P: 'gen_ai.request.top_p',
	REQUEST_FREQUENCY_PENALTY: 'gen_ai.request.frequency_penalty',
	REQUEST_PRESENCE_PENALTY: 'gen_ai.request.presence_penalty',
	REQUEST_SEED: 'gen_ai.request.seed',
	REQUEST_STOP_SEQUENCES: 'gen_ai.request.stop_sequences',

	// Response
	RESPONSE_MODEL: 'gen_ai.response.model',
	RESPONSE_ID: 'gen_ai.response.id',
	RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',

	// Usage
	USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
	USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
	USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
	USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',

	// Conversation
	CONVERSATION_ID: 'gen_ai.conversation.id',
	OUTPUT_TYPE: 'gen_ai.output.type',

	// Token type (for metrics)
	TOKEN_TYPE: 'gen_ai.token.type',

	// Agent
	AGENT_NAME: 'gen_ai.agent.name',
	AGENT_ID: 'gen_ai.agent.id',
	AGENT_VERSION: 'gen_ai.agent.version',
	AGENT_DESCRIPTION: 'gen_ai.agent.description',

	// Tool
	TOOL_NAME: 'gen_ai.tool.name',
	TOOL_TYPE: 'gen_ai.tool.type',
	TOOL_CALL_ID: 'gen_ai.tool.call.id',
	TOOL_DESCRIPTION: 'gen_ai.tool.description',
	TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
	TOOL_CALL_RESULT: 'gen_ai.tool.call.result',

	// Content (opt-in)
	INPUT_MESSAGES: 'gen_ai.input.messages',
	OUTPUT_MESSAGES: 'gen_ai.output.messages',
	SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
	TOOL_DEFINITIONS: 'gen_ai.tool.definitions',
} as const;

/**
 * Extension-specific attribute keys (custom namespace).
 */
export const CopilotAttr = {
	LOCATION: 'copilot.location',
	INTENT: 'copilot.intent',
	TURN_INDEX: 'copilot.turn.index',
	TOOL_CALL_ROUND: 'copilot.tool_call_round',
	API_TYPE: 'copilot.api_type',
	FETCHER: 'copilot.fetcher',
} as const;

/**
 * Standard OTel attributes used alongside GenAI attributes.
 */
export const StdAttr = {
	ERROR_TYPE: 'error.type',
	SERVER_ADDRESS: 'server.address',
	SERVER_PORT: 'server.port',
} as const;
