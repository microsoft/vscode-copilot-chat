import { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatQuotaService } from '../../chat/common/chatQuotaService';
import { ChatLocation } from '../../chat/common/commonTypes';
import { IInteractionService } from '../../chat/common/interactionService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IChatEndpointProvider } from '../../prompt/common/chatEndpointProvider';
import { TelemetryData } from '../../telemetry/common/telemetry';
import {
  ChatParams,
  ChatRequest,
  ChatResults,
  FetchResponseKind,
  fetchAndStreamChat,
  ChatFailKind,
} from '../../openai/node/fetch'; // Assuming this is the correct path
import {
  ILanguageModelProvider,
  LanguageModelChatRequest,
  LanguageModelChatResponseChunk,
  LanguageModelCapabilities,
  LanguageModelChatMessage,
  LanguageModelError,
} from '../common/languageModelProvider';
import { CAPIChatMessage } from '../../networking/common/openai';

const COPILOT_OFFICIAL_PROVIDER_ID = 'copilot-official';
const COPILOT_OFFICIAL_DISPLAY_NAME = 'GitHub Copilot (Official)';

// Helper to map our abstract roles to CAPI roles
function toCAPIRole(role: LanguageModelChatMessage['role']): CAPIChatMessage['role'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool': // TODO: CAPI might have a specific 'tool' or 'function' role. Adjust if necessary.
      return 'user'; // Placeholder, verify CAPI's tool message structure
    default:
      // Exhaustive check
      const _: never = role;
      throw new Error(`Unknown LanguageModelChatMessage role: ${role}`);
  }
}


export class CopilotOfficialLanguageModelProvider implements ILanguageModelProvider {
  readonly id = COPILOT_OFFICIAL_PROVIDER_ID;
  readonly displayName = COPILOT_OFFICIAL_DISPLAY_NAME;

  constructor(
    @ILogService private readonly logService: ILogService,
    @ITelemetryService private readonly telemetryService: ITelemetryService,
    @IFetcherService private readonly fetcherService: IFetcherService,
    @IEnvService private readonly envService: IEnvService,
    @IChatQuotaService private readonly chatQuotaService: IChatQuotaService,
    @IDomainService private readonly domainService: IDomainService,
    @ICAPIClientService private readonly capiClientService: ICAPIClientService,
    @IInteractionService private readonly interactionService: IInteractionService,
    @IChatEndpointProvider private readonly chatEndpointProvider: IChatEndpointProvider,
  ) {
    this.logService.info(`CopilotOfficialLanguageModelProvider: Initialized`);
  }

  async isAvailable(cancellationToken: CancellationToken): Promise<boolean> {
    try {
      const token = await this.authService.getCopilotToken(true, cancellationToken); // force validation
      return !!token && !token.isChatDisabled && !token.isTokenInvalidOrExpired;
    } catch (error) {
      this.logService.error('CopilotOfficialLanguageModelProvider: Error checking availability:', error);
      return false;
    }
  }

  async getCapabilities(cancellationToken: CancellationToken): Promise<LanguageModelCapabilities> {
    // For the official provider, these are generally known.
    // We might want to make this more dynamic if different models become available
    // through the official endpoint with varying capabilities.
    const endpoint = await this.chatEndpointProvider.getChatEndpoint(false, cancellationToken);
    return {
      streaming: true,
      maxContextTokens: endpoint.modelMaxPromptTokens ?? 8192, // Default, but should come from endpoint
      toolUsage: true, // Official Copilot supports tools
      supportedModels: [endpoint.modelDeploymentName], // The model name from the endpoint
    };
  }

  async streamChatCompletions(
    request: LanguageModelChatRequest,
    cancellationToken: CancellationToken
  ): AsyncIterable<LanguageModelChatResponseChunk> {
    this.logService.info(`CopilotOfficialLanguageModelProvider: Streaming chat completions for model ${request.modelId || 'default'}`);

    const token = await this.authService.getCopilotToken(false, cancellationToken);
    if (!token || token.isTokenInvalidOrExpired) {
      throw new LanguageModelError('Authentication token is invalid or expired.', this.id, undefined, ChatFailKind.TokenExpiredOrInvalid);
    }
    if (token.isChatDisabled) {
        throw new LanguageModelError('Chat is disabled for your account.', this.id, undefined, ChatFailKind.ExtensionBlocked); // Or a more specific error code
    }

    const endpoint = await this.chatEndpointProvider.getChatEndpoint(request.messages.some(m => m.role === 'user'), cancellationToken); // isUserRequest

    const capiMessages: CAPIChatMessage[] = request.messages.map(m => ({
      role: toCAPIRole(m.role),
      content: m.content,
      // TODO: Map tool calls if CAPI has a specific format for them
    }));

    const chatParams: ChatParams = {
      messages: capiMessages,
      model: request.modelId || endpoint.modelDeploymentName, // Use specific model if provided, else endpoint default
      location: ChatLocation.Agent, // Or derive from a context passed into the request
      ourRequestId: '', // fetchAndStreamChat will generate one if not provided by a higher layer
      postOptions: {
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stop: request.stop,
        user: request.user,
        // TODO: Map other OptionalChatRequestParams if they are added to LanguageModelChatRequest
      },
      // TODO: Handle requestLogProbs, intent, intent_threshold if needed at this abstraction level
    };

    // Base telemetry data - can be enriched
    const baseTelemetryData = TelemetryData.createAndMarkAsIssued({});

    const finishedCb = (
        request: Partial<ChatRequest>,
        response: ChatResults | undefined,
        reason: string,
        error?: any,
        modelRequestId?: string
      ) => {
        // Handle logging or telemetry for finished requests if needed
        if (error) {
            this.logService.error(`CopilotOfficialLanguageModelProvider: Request finished with error. Reason: ${reason}. ModelReqID: ${modelRequestId}`, error);
        } else if (response?.type === FetchResponseKind.Failed) {
            this.logService.warn(`CopilotOfficialLanguageModelProvider: Request finished with failure. Reason: ${response.reason}. ModelReqID: ${response.modelRequestId}`);
        } else if (response?.type === FetchResponseKind.Canceled) {
            this.logService.info(`CopilotOfficialLanguageModelProvider: Request canceled. Reason: ${response.reason}.`);
        } else {
            this.logService.info(`CopilotOfficialLanguageModelProvider: Request finished successfully. Reason: ${reason}. ModelReqID: ${modelRequestId}`);
        }
    };

    try {
      const result = await fetchAndStreamChat(
        this.logService,
        this.telemetryService,
        this.fetcherService,
        this.envService,
        this.chatQuotaService,
        this.domainService,
        this.capiClientService,
        this.authService,
        this.interactionService,
        endpoint,
        chatParams,
        baseTelemetryData,
        finishedCb,
        true, // userInitiatedRequest - assume true for now
        cancellationToken
      );

      if (result.type === FetchResponseKind.Success) {
        return this.adaptStreamToLMChunks(result.chatCompletions);
      } else if (result.type === FetchResponseKind.Failed) {
        this.logService.error(`CopilotOfficialLanguageModelProvider: Chat request failed: ${result.reason}`, result.data);
        throw new LanguageModelError(result.reason, this.id, result.data, result.failKind);
      } else if (result.type === FetchResponseKind.Canceled) {
        this.logService.info(`CopilotOfficialLanguageModelProvider: Chat request canceled: ${result.reason}`);
        // For a canceled request, we can either throw a specific error or return an empty async iterable.
        // Throwing an error might be more explicit.
        throw new LanguageModelError(result.reason, this.id, undefined, 'canceled');
      } else {
        // Should be exhaustive
        const _: never = result;
        throw new LanguageModelError('Unknown response type from fetchAndStreamChat', this.id);
      }
    } catch (error: any) {
      this.logService.error('CopilotOfficialLanguageModelProvider: Error during fetchAndStreamChat:', error);
      if (error instanceof LanguageModelError) throw error;
      throw new LanguageModelError(error.message || 'Failed to stream chat completions', this.id, error);
    }
  }

  private async *adaptStreamToLMChunks(
    capiStream: AsyncIterable<any /* ChatCompletion from CAPI */>
  ): AsyncIterable<LanguageModelChatResponseChunk> {
    for await (const capiChunk of capiStream) {
      // Assuming capiChunk has a structure like:
      // { choices: [{ delta: { content: "...", role: "assistant" }, finish_reason: "..." }] }
      // This needs to be adapted based on the actual structure of ChatCompletion
      if (capiChunk.choices && capiChunk.choices.length > 0) {
        const choice = capiChunk.choices[0];
        const chunk: LanguageModelChatResponseChunk = {};
        if (choice.delta?.content) {
          chunk.content = choice.delta.content;
        }
        if (choice.delta?.role) {
          chunk.role = choice.delta.role; // Assuming role is 'assistant'
        }
        if (choice.finish_reason) {
          chunk.finishReason = choice.finish_reason;
          // If finish_reason is present, this is the last meaningful chunk for this choice.
          // The 'usage' is on the ChatCompletion object itself (capiChunk).
          if (capiChunk.usage) {
            chunk.usage = capiChunk.usage;
          }
        }
        // Always yield the chunk if it has any data, even if it's just content
        if (chunk.content || chunk.role || chunk.finishReason || chunk.usage) {
            yield chunk;
        }
      }
    }
  }
}
