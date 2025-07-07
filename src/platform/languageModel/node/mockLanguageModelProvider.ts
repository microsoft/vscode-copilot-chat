import { CancellationToken } from 'vscode';
import { ILogService } from '../../log/common/logService';
import {
  ILanguageModelProvider,
  LanguageModelChatRequest,
  LanguageModelChatResponseChunk,
  LanguageModelCapabilities,
  LanguageModelError,
} from '../common/languageModelProvider';
import { APIUsage } from '../../networking/common/openai';

const MOCK_PROVIDER_ID = 'mock-provider';
const MOCK_PROVIDER_DISPLAY_NAME = 'Mock LLM Provider (Testing)';

export class MockLanguageModelProvider implements ILanguageModelProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly displayName = MOCK_PROVIDER_DISPLAY_NAME;

  constructor(@ILogService private readonly logService: ILogService) {
    this.logService.info(`MockLanguageModelProvider: Initialized`);
  }

  async isAvailable(cancellationToken: CancellationToken): Promise<boolean> {
    this.logService.info(`MockLanguageModelProvider: isAvailable called`);
    return true;
  }

  async getCapabilities(cancellationToken: CancellationToken): Promise<LanguageModelCapabilities> {
    this.logService.info(`MockLanguageModelProvider: getCapabilities called`);
    return {
      streaming: true,
      maxContextTokens: 4096,
      toolUsage: false, // Mock doesn't support tools for now
      supportedModels: ['mock-model-1'],
    };
  }

  async *streamChatCompletions(
    request: LanguageModelChatRequest,
    cancellationToken: CancellationToken
  ): AsyncIterable<LanguageModelChatResponseChunk> {
    this.logService.info(`MockLanguageModelProvider: streamChatCompletions called with request:`, request.messages.map(m => m.content));

    if (cancellationToken.isCancellationRequested) {
      this.logService.info('MockLanguageModelProvider: Cancellation requested before streaming started.');
      throw new LanguageModelError('Request cancelled by token', this.id, undefined, 'canceled');
    }

    const firstUserMessage = request.messages.find(m => m.role === 'user')?.content || 'nothing';
    const responsePrefix = `Hello! You said: "${firstUserMessage.substring(0, 50)}${firstUserMessage.length > 50 ? '...' : ''}". `;
    const responseSuffix = `This is a mock response from ${this.displayName}.`;

    const words = (responsePrefix + responseSuffix).split(' ');
    let charCount = 0;

    for (let i = 0; i < words.length; i++) {
      if (cancellationToken.isCancellationRequested) {
        this.logService.info('MockLanguageModelProvider: Cancellation requested during streaming.');
        throw new LanguageModelError('Request cancelled by token during stream', this.id, undefined, 'canceled');
      }
      const word = words[i] + (i < words.length - 1 ? ' ' : '');
      charCount += word.length;
      yield { content: word, role: 'assistant' };
      // Simulate delay
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const mockUsage: APIUsage = {
        prompt_tokens: request.messages.reduce((sum, msg) => sum + (msg.content?.length || 0) / 4, 0), // very rough estimate
        completion_tokens: charCount / 4, // very rough estimate
        total_tokens: (request.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) + charCount) / 4,
        prompt_tokens_details: { cached_tokens: 0}
    };

    yield {
      finishReason: 'stop',
      usage: mockUsage
    };
    this.logService.info(`MockLanguageModelProvider: Streaming finished.`);
  }
}
