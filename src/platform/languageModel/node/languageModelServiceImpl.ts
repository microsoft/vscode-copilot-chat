import { CancellationToken } from 'vscode';
import { Emitter, Event } from '../../../util/common/event';
import { Disposable } from '../../../util/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IConfigurationService } from '../../configuration/common/configuration';
import { ILanguageModelProvider, LanguageModelChatRequest, LanguageModelChatResponseChunk, LanguageModelCapabilities, LanguageModelError } from '../common/languageModelProvider';
import { ILanguageModelService } from '../common/languageModelService';

const LANGUAGE_MODEL_PROVIDER_CONFIG_KEY = 'github.copilot.chat.languageModelProviderId';

export class LanguageModelServiceImpl extends Disposable implements ILanguageModelService {
  readonly _serviceBrand: undefined;

  private readonly _providers: Map<string, ILanguageModelProvider> = new Map();
  private _selectedProviderId: string | undefined;

  private readonly _onDidChangeProviders = this._register(new Emitter<void>());
  public readonly onDidChangeProviders: Event<void> = this._onDidChangeProviders.event;

  constructor(
    @ILogService private readonly logService: ILogService,
    @IConfigurationService private readonly configurationService: IConfigurationService
  ) {
    super();
    this._register(this.configurationService.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(LANGUAGE_MODEL_PROVIDER_CONFIG_KEY)) {
        this.updateSelectedProvider();
        this._onDidChangeProviders.fire();
      }
    }));
    this.updateSelectedProvider();
  }

  private updateSelectedProvider(): void {
    this._selectedProviderId = this.configurationService.getValue<string>(LANGUAGE_MODEL_PROVIDER_CONFIG_KEY);
    this.logService.info(`LanguageModelService: Selected provider ID updated to "${this._selectedProviderId}"`);
  }

  registerProvider(provider: ILanguageModelProvider): void {
    if (this._providers.has(provider.id)) {
      this.logService.warn(`LanguageModelService: Provider with ID "${provider.id}" is already registered. Overwriting.`);
    }
    this._providers.set(provider.id, provider);
    this.logService.info(`LanguageModelService: Provider "${provider.displayName}" (ID: ${provider.id}) registered.`);
    this._onDidChangeProviders.fire();
  }

  getProviderIds(): string[] {
    return Array.from(this._providers.keys());
  }

  getProvider(id: string): ILanguageModelProvider | undefined {
    return this._providers.get(id);
  }

  async getSelectedProvider(): Promise<ILanguageModelProvider | undefined> {
    if (!this._selectedProviderId) {
      this.logService.debug(`LanguageModelService: No provider ID is configured.`);
      // Attempt to use the first registered, available provider if none is explicitly selected
      for (const provider of this._providers.values()) {
        if (await provider.isAvailable(CancellationToken.None)) {
          this.logService.info(`LanguageModelService: No provider configured, defaulting to first available: ${provider.id}`);
          this._selectedProviderId = provider.id; // Cache this implicit selection
          return provider;
        }
      }
      this.logService.warn(`LanguageModelService: No provider configured and no available providers found.`);
      return undefined;
    }
    const provider = this._providers.get(this._selectedProviderId);
    if (!provider) {
      this.logService.warn(`LanguageModelService: Configured provider ID "${this._selectedProviderId}" not found.`);
      return undefined;
    }
    if (!await provider.isAvailable(CancellationToken.None)) {
      this.logService.warn(`LanguageModelService: Selected provider "${provider.displayName}" (ID: ${provider.id}) is not available.`);
      return undefined;
    }
    return provider;
  }

  async getSelectedProviderCapabilities(cancellationToken: CancellationToken): Promise<LanguageModelCapabilities | undefined> {
    const provider = await this.getSelectedProvider();
    if (!provider) {
      return undefined;
    }
    try {
      return await provider.getCapabilities(cancellationToken);
    } catch (error) {
      this.logService.error(`LanguageModelService: Error getting capabilities from provider "${provider.id}":`, error);
      if (error instanceof LanguageModelError) {
        throw error;
      }
      throw new LanguageModelError(`Failed to get capabilities from provider ${provider.id}`, provider.id, error);
    }
  }

  async streamChatCompletions(
    request: LanguageModelChatRequest,
    cancellationToken: CancellationToken
  ): Promise<AsyncIterable<LanguageModelChatResponseChunk>> { // Note: Outer Promise for provider selection
    const provider = await this.getSelectedProvider();
    if (!provider) {
      this.logService.error('LanguageModelService: No language model provider is selected or available.');
      throw new LanguageModelError('No language model provider selected or available.', 'none');
    }

    this.logService.debug(`LanguageModelService: Streaming chat completions using provider "${provider.displayName}" (ID: ${provider.id})`);
    try {
      // The provider's method itself returns the AsyncIterable directly
      return provider.streamChatCompletions(request, cancellationToken);
    } catch (error) {
      this.logService.error(`LanguageModelService: Error streaming chat completions from provider "${provider.id}":`, error);
      if (error instanceof LanguageModelError) {
        throw error;
      }
      throw new LanguageModelError(`Failed to stream chat completions from provider ${provider.id}`, provider.id, error);
    }
  }
}
