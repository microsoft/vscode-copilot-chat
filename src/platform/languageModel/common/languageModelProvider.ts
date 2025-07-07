import { CancellationToken } from 'vscode';

/**
 * Represents a message in a chat conversation.
 */
export interface LanguageModelChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // TODO: Consider adding tool_calls, tool_call_id if we want to abstract that too.
  // For now, tools might be handled by the calling agent/service before hitting the provider.
}

/**
 * Parameters for a chat completion request to a language model provider.
 */
export interface LanguageModelChatRequest {
  /**
   * Messages to send to the model.
   */
  messages: LanguageModelChatMessage[];
  /**
   * The specific model ID to use for this request (provider-specific).
   */
  modelId?: string;
  /**
   * Sampling temperature.
   */
  temperature?: number;
  /**
   * Maximum number of tokens to generate.
   */
  maxTokens?: number;
  /**
   * Stop sequences.
   */
  stop?: string[];
  /**
   * An optional identifier for the user making the request.
   */
  user?: string;
  // TODO: Add other common parameters like top_p, presence_penalty, frequency_penalty if needed.
}

/**
 * Represents a chunk of a streamed chat response.
 */
import { APIUsage } from '../../networking/common/openai'; // Added import

export interface LanguageModelChatResponseChunk {
  /**
   * The content of the chunk, typically a piece of text.
   */
  content?: string;
  /**
   * The role of the message, usually 'assistant'.
   */
  role?: 'assistant';
  /**
   * Information about why the generation finished, if it did.
   */
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  /**
   * Usage statistics, typically provided with the last chunk or when finishReason is set.
   */
  usage?: APIUsage;
  // TODO: Add tool_calls if abstracting tool usage at this level.
}

/**
 * Describes the capabilities of a language model provider or a specific model.
 */
export interface LanguageModelCapabilities {
  /**
   * Whether the provider supports streaming responses.
   */
  streaming: boolean;
  /**
   * Maximum context window size in tokens.
   */
  maxContextTokens: number;
  /**
   * Whether the model/provider explicitly supports tool usage (function calling).
   */
  toolUsage?: boolean;
  /**
   * List of model IDs supported by this provider.
   * If undefined, it's assumed the provider has a default model or manages models internally.
   */
  supportedModels?: string[];
}

/**
 * Interface for a pluggable language model provider.
 */
export interface ILanguageModelProvider {
  /**
   * A unique identifier for this provider (e.g., "copilot-official", "ollama", "azure-openai").
   */
  readonly id: string;

  /**
   * A user-friendly display name for this provider.
   */
  readonly displayName: string;

  /**
   * Checks if the provider is configured and available for use.
   * This might involve checking for API keys, endpoint reachability, etc.
   * @param cancellationToken A token to signal cancellation of the check.
   * @returns A promise that resolves to true if available, false otherwise.
   */
  isAvailable(cancellationToken: CancellationToken): Promise<boolean>;

  /**
   * Gets the capabilities of this provider.
   * This might be dynamic based on configuration or fetched from an endpoint.
   * @param cancellationToken A token to signal cancellation of the check.
   * @returns A promise that resolves to the provider's capabilities.
   */
  getCapabilities(cancellationToken: CancellationToken): Promise<LanguageModelCapabilities>;

  /**
   * Streams chat completions from the language model.
   * @param request The chat request parameters.
   * @param cancellationToken A token to signal cancellation of the request.
   * @returns An async iterable of chat response chunks.
   * @throws LanguageModelError if the request fails.
   */
  streamChatCompletions(
    request: LanguageModelChatRequest,
    cancellationToken: CancellationToken
  ): AsyncIterable<LanguageModelChatResponseChunk>;

  // TODO: Future methods for embeddings, etc.
  // generateEmbeddings(request: LanguageModelEmbeddingRequest, cancellationToken: CancellationToken): Promise<LanguageModelEmbeddingResponse>;
}

/**
 * Custom error class for language model provider issues.
 */
export class LanguageModelError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly originalError?: any,
    public readonly errorCode?: string // Provider-specific error code
  ) {
    super(message);
    this.name = 'LanguageModelError';
  }
}
