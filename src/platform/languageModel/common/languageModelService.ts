import { CancellationToken } from 'vscode';
import { Event } from '../../../util/common/event';
import { createServiceIdentifier } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ILanguageModelProvider, LanguageModelChatRequest, LanguageModelChatResponseChunk, LanguageModelCapabilities } from './languageModelProvider';

export const ILanguageModelService = createServiceIdentifier<ILanguageModelService>('languageModelService');

export interface ILanguageModelService {
  readonly _serviceBrand: undefined;

  /**
   * Event that fires when the list of available providers changes or the selected provider changes.
   */
  onDidChangeProviders: Event<void>;

  /**
   * Registers a language model provider.
   * @param provider The provider to register.
   */
  registerProvider(provider: ILanguageModelProvider): void;

  /**
   * Gets a list of all registered provider IDs.
   * @returns An array of provider IDs.
   */
  getProviderIds(): string[];

  /**
   * Gets a specific provider by its ID.
   * @param id The ID of the provider.
   * @returns The provider, or undefined if not found.
   */
  getProvider(id: string): ILanguageModelProvider | undefined;

  /**
   * Gets the currently selected language model provider based on user configuration.
   * @returns The selected provider, or undefined if none is selected or available.
   */
  getSelectedProvider(): Promise<ILanguageModelProvider | undefined>;

  /**
   * Gets the capabilities of the currently selected language model provider.
   * @param cancellationToken A token to signal cancellation.
   * @returns A promise that resolves to the capabilities, or undefined if no provider is selected/available.
   */
  getSelectedProviderCapabilities(cancellationToken: CancellationToken): Promise<LanguageModelCapabilities | undefined>;

  /**
   * Streams chat completions from the currently selected language model provider.
   * @param request The chat request parameters.
   * @param cancellationToken A token to signal cancellation of the request.
   * @returns An async iterable of chat response chunks.
   * @throws Error if no provider is selected or available, or if the selected provider fails.
   */
  streamChatCompletions(
    request: LanguageModelChatRequest,
    cancellationToken: CancellationToken
  ): AsyncIterable<LanguageModelChatResponseChunk>;
}
