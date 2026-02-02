/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RequestMetadata, RequestType } from '@vscode/copilot-api';
import * as l10n from '@vscode/l10n';
import { OpenAI, Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { createRequestHMAC } from '../../../util/common/crypto';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { deepClone, mixin } from '../../../util/vs/base/common/objects';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { getTextPart } from '../../chat/common/globalStringUtils';
import { CHAT_MODEL, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { isAnthropicContextEditingEnabled, isAnthropicToolSearchEnabled } from '../../networking/common/anthropic';
import { FinishedCallback, ICopilotToolCall, OptionalChatRequestParams } from '../../networking/common/fetch';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { createCapiRequestBody, IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions, postRequest } from '../../networking/common/networking';
import { CAPIChatMessage, ChatCompletion, FinishedCompletionReason, RawMessageConversionCallback } from '../../networking/common/openai';
import { prepareChatCompletionForReturn } from '../../networking/node/chatStream';
import { SSEProcessor } from '../../networking/node/stream';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { isAnthropicFamily, isGeminiFamily } from '../common/chatModelCapabilities';
import { IDomainService } from '../common/domainService';
import { CustomModel, IChatModelInformation, ModelPolicy, ModelSupportedEndpoint } from '../common/endpointProvider';
import { createMessagesRequestBody, processResponseFromMessagesEndpoint } from './messagesApi';
import { createResponsesRequestBody, processResponseFromChatEndpoint } from './responsesApi';

/**
 * The default processor for the stream format from CAPI
 */
export async function defaultChatResponseProcessor(
	telemetryService: ITelemetryService,
	logService: ILogService,
	response: Response,
	expectedNumChoices: number,
	finishCallback: FinishedCallback,
	telemetryData: TelemetryData,
	cancellationToken?: CancellationToken | undefined
) {
	const processor = await SSEProcessor.create(logService, telemetryService, expectedNumChoices, response, cancellationToken);
	const finishedCompletions = processor.processSSE(finishCallback);
	const chatCompletions = AsyncIterableObject.map(finishedCompletions, (solution) => {
		const loggedReason = solution.reason ?? 'client-trimmed';
		const dataToSendToTelemetry = telemetryData.extendedBy({
			completionChoiceFinishReason: loggedReason,
			headerRequestId: solution.requestId.headerRequestId
		});
		telemetryService.sendGHTelemetryEvent('completion.finishReason', dataToSendToTelemetry.properties, dataToSendToTelemetry.measurements);
		return prepareChatCompletionForReturn(telemetryService, logService, solution, telemetryData);
	});
	return chatCompletions;
}

export async function defaultNonStreamChatResponseProcessor(response: Response, finishCallback: FinishedCallback, telemetryData: TelemetryData) {
	const textResponse = await response.text();
	const jsonResponse = JSON.parse(textResponse);
	const completions: ChatCompletion[] = [];
	for (let i = 0; i < (jsonResponse?.choices?.length || 0); i++) {
		const choice = jsonResponse.choices[i];
		const message: Raw.AssistantChatMessage = {
			role: choice.message.role,
			content: choice.message.content,
			name: choice.message.name,
			// Normalize property name: OpenAI API uses snake_case (tool_calls) but our types expect camelCase (toolCalls)
			// See: https://platform.openai.com/docs/api-reference/chat/object#chat-object-choices-message-tool_calls
			toolCalls: choice.message.toolCalls ?? choice.message.tool_calls,
		};
		const messageText = getTextPart(message.content);
		const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
		const ghRequestId = response.headers.get('x-github-request-id') ?? '';


		const completion: ChatCompletion = {
			blockFinished: false,
			choiceIndex: i,
			model: jsonResponse.model,
			filterReason: undefined,
			finishReason: choice.finish_reason as FinishedCompletionReason,
			message: message,
			usage: jsonResponse.usage,
			tokens: [], // This is used for repetition detection so not super important to be accurate
			requestId: { headerRequestId: requestId, gitHubRequestId: ghRequestId, completionId: jsonResponse.id, created: jsonResponse.created, deploymentId: '', serverExperiments: '' },
			telemetryData: telemetryData
		};
		const functionCall: ICopilotToolCall[] = [];
		for (const tool of message.toolCalls ?? []) {
			functionCall.push({
				name: tool.function?.name ?? '',
				arguments: tool.function?.arguments ?? '',
				id: tool.id ?? '',
			});
		}
		await finishCallback(messageText, i, {
			text: messageText,
			copilotToolCalls: functionCall,
		});
		completions.push(completion);
	}

	return AsyncIterableObject.fromArray(completions);
}

export class ChatEndpoint implements IChatEndpoint {
	private readonly _maxTokens: number;
	private readonly _maxOutputTokens: number;
	public readonly model: string;
	public readonly name: string;
	public readonly version: string;
	public readonly family: string;
	public readonly tokenizer: TokenizerType;
	public readonly showInModelPicker: boolean;
	public readonly isFallback: boolean;
	public readonly supportsToolCalls: boolean;
	public readonly supportsVision: boolean;
	public readonly supportsPrediction: boolean;
	public readonly isPremium?: boolean | undefined;
	public readonly multiplier?: number | undefined;
	public readonly restrictedToSkus?: string[] | undefined;
	public readonly customModel?: CustomModel | undefined;
	public readonly maxPromptImages?: number | undefined;

	private readonly _supportsStreaming: boolean;
	private _policyDetails: ModelPolicy | undefined;

	constructor(
		public readonly modelMetadata: IChatModelInformation,
		@IDomainService protected readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IChatMLFetcher private readonly _chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ILogService _logService: ILogService,
	) {
		// This metadata should always be present, but if not we will default to 8192 tokens
		this._maxTokens = modelMetadata.capabilities.limits?.max_prompt_tokens ?? 8192;
		// This metadata should always be present, but if not we will default to 4096 tokens
		this._maxOutputTokens = modelMetadata.capabilities.limits?.max_output_tokens ?? 4096;
		this.model = modelMetadata.id;
		this.name = modelMetadata.name;
		this.version = modelMetadata.version;
		this.family = modelMetadata.capabilities.family;
		this.tokenizer = modelMetadata.capabilities.tokenizer;
		this.showInModelPicker = modelMetadata.model_picker_enabled;
		this.isPremium = modelMetadata.billing?.is_premium;
		this.multiplier = modelMetadata.billing?.multiplier;
		this.restrictedToSkus = modelMetadata.billing?.restricted_to;
		this.isFallback = modelMetadata.is_chat_fallback;
		this.supportsToolCalls = !!modelMetadata.capabilities.supports.tool_calls;
		this.supportsVision = !!modelMetadata.capabilities.supports.vision;
		this.supportsPrediction = !!modelMetadata.capabilities.supports.prediction;
		this._supportsStreaming = !!modelMetadata.capabilities.supports.streaming;
		this._policyDetails = modelMetadata.policy;
		this.customModel = modelMetadata.custom_model;
		this.maxPromptImages = modelMetadata.capabilities.limits?.vision?.max_prompt_images;
	}

	public getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = { ...this.modelMetadata.requestHeaders };

		if (this.useMessagesApi) {

			const modelProviderPreference = this._configurationService.getConfig(ConfigKey.TeamInternal.ModelProviderPreference);
			if (modelProviderPreference) {
				headers['X-Model-Provider-Preference'] = modelProviderPreference;
			}

			const betaFeatures: string[] = [];

			// Add thinking beta if enabled
			if (this._getThinkingBudget()) {
				betaFeatures.push('interleaved-thinking-2025-05-14');
			}

			// Add context management beta if enabled
			if (isAnthropicContextEditingEnabled(this.model, this._configurationService, this._expService)) {
				betaFeatures.push('context-management-2025-06-27');
			}

			// Add tool search beta if enabled
			if (isAnthropicToolSearchEnabled(this.model, this._configurationService, this._expService)) {
				betaFeatures.push('advanced-tool-use-2025-11-20');
			}

			if (betaFeatures.length > 0) {
				headers['anthropic-beta'] = betaFeatures.join(',');
			}
		}

		return headers;
	}

	private _getThinkingBudget(): number | undefined {
		const configuredBudget = this._configurationService.getExperimentBasedConfig(ConfigKey.AnthropicThinkingBudget, this._expService);
		if (!configuredBudget || configuredBudget <= 0) {
			return undefined;
		}
		const normalizedBudget = configuredBudget < 1024 ? 1024 : configuredBudget;
		// Cap thinking budget to Anthropic's recommended max (32000), and ensure it's less than max output tokens
		return Math.min(32000, this._maxOutputTokens - 1, normalizedBudget);
	}

	public get modelMaxPromptTokens(): number {
		return this._maxTokens;
	}

	public get maxOutputTokens(): number {
		return this._maxOutputTokens;
	}

	public get urlOrRequestMetadata(): string | RequestMetadata {
		// Use override or respect setting.
		// TODO unlikely but would break if it changes in the middle of a request being constructed
		return this.modelMetadata.urlOrRequestMetadata ??
			(this.useResponsesApi ? { type: RequestType.ChatResponses } :
				this.useMessagesApi ? { type: RequestType.ChatMessages } : { type: RequestType.ChatCompletions });
	}

	protected get useResponsesApi(): boolean {
		if (this.modelMetadata.supported_endpoints
			&& !this.modelMetadata.supported_endpoints.includes(ModelSupportedEndpoint.ChatCompletions)
			&& this.modelMetadata.supported_endpoints.includes(ModelSupportedEndpoint.Responses)
		) {
			return true;
		}

		return !!this.modelMetadata.supported_endpoints?.includes(ModelSupportedEndpoint.Responses);
	}

	protected get useMessagesApi(): boolean {
		const enableMessagesApi = this._configurationService.getExperimentBasedConfig(ConfigKey.UseAnthropicMessagesApi, this._expService);
		return !!(enableMessagesApi && this.modelMetadata.supported_endpoints?.includes(ModelSupportedEndpoint.Messages));
	}

	public get degradationReason(): string | undefined {
		return this.modelMetadata.warning_messages?.at(0)?.message ?? this.modelMetadata.info_messages?.at(0)?.message;
	}

	public get policy(): 'enabled' | { terms: string } {
		if (!this._policyDetails) {
			return 'enabled';
		}
		if (this._policyDetails.state === 'enabled') {
			return 'enabled';
		}
		return { terms: this._policyDetails.terms ?? 'Unknown policy terms' };
	}

	public get apiType(): string {
		return this.useResponsesApi ? 'responses' :
			this.useMessagesApi ? 'messages' : 'chatCompletions';
	}

	interceptBody(body: IEndpointBody | undefined): void {
		// Remove tool calls from requests that don't support them
		// We really shouldn't make requests to models that don't support tool calls with tools though
		if (body && !this.supportsToolCalls) {
			delete body['tools'];
		}

		// If the model doesn't support streaming, don't ask for a streamed request
		if (body && !this._supportsStreaming) {
			body.stream = false;
		}

		// If it's o1 we must modify the body significantly as the request is very different
		if (body?.messages && (this.family.startsWith('o1') || this.model === CHAT_MODEL.O1 || this.model === CHAT_MODEL.O1MINI)) {
			const newMessages: CAPIChatMessage[] = body.messages.map((message: CAPIChatMessage): CAPIChatMessage => {
				if (message.role === OpenAI.ChatRole.System) {
					return {
						role: OpenAI.ChatRole.User,
						content: message.content,
					};
				} else {
					return message;
				}
			});
			// Add the messages & model back
			body['messages'] = newMessages;
		}
	}

	createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		// Validate image count if endpoint has max_prompt_images limit (Gemini only for now)
		if (isGeminiFamily(this) && this.maxPromptImages !== undefined) {
			const imageCount = this.countImages(options.messages, this.maxPromptImages);
			if (imageCount > this.maxPromptImages) {
				const errorMsg = l10n.t('Too many images in request: {0} images provided, but the model supports a maximum of {1} images.', imageCount, this.maxPromptImages);
				throw new Error(errorMsg);
			}
		}

		if (this.useResponsesApi) {
			const body = this._instantiationService.invokeFunction(createResponsesRequestBody, options, this.model, this);
			return this.customizeResponsesBody(body);
		} else if (this.useMessagesApi) {
			const body = this._instantiationService.invokeFunction(createMessagesRequestBody, options, this.model, this);
			return this.customizeMessagesBody(body);
		} else {
			const body = createCapiRequestBody(options, this.model, this.getCompletionsCallback());
			return this.customizeCapiBody(body, options);
		}
	}

	private countImages(messages: Raw.ChatMessage[], maxAllowed?: number): number {
		let imageCount = 0;
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === Raw.ChatCompletionContentPartKind.Image) {
						imageCount++;
						// Early exit if we've already exceeded the limit
						if (maxAllowed !== undefined && imageCount > maxAllowed) {
							return imageCount;
						}
					}
				}
			}
		}
		return imageCount;
	}

	protected getCompletionsCallback(): RawMessageConversionCallback | undefined {
		return undefined;
	}

	protected customizeMessagesBody(body: IEndpointBody): IEndpointBody {
		return body;
	}

	protected customizeResponsesBody(body: IEndpointBody): IEndpointBody {
		return body;
	}

	protected customizeCapiBody(body: IEndpointBody, options: ICreateEndpointBodyOptions): IEndpointBody {
		const isConversationAgent = options.location === ChatLocation.Agent;
		if (isAnthropicFamily(this) && !options.disableThinking && isConversationAgent) {
			const thinkingBudget = this._getThinkingBudget();
			if (thinkingBudget) {
				body.thinking_budget = thinkingBudget;
			}
		}

		// Apply Gemini function calling mode if configured
		const hasTools = !!options.requestOptions?.tools?.length;
		if (hasTools && this.family.toLowerCase().includes('gemini-3')) {
			const geminiFunctionCallingMode = this._configurationService.getExperimentBasedConfig(
				ConfigKey.TeamInternal.GeminiFunctionCallingMode,
				this._expService
			);
			// Only override tool_choice if experiment provides a value and user hasn't specified a function call
			if (geminiFunctionCallingMode && typeof body.tool_choice !== 'object') {
				body.tool_choice = geminiFunctionCallingMode;
			}
		}

		return body;
	}

	public async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		if (this.useResponsesApi) {
			return processResponseFromChatEndpoint(this._instantiationService, telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData);
		} else if (this.useMessagesApi) {
			return processResponseFromMessagesEndpoint(this._instantiationService, telemetryService, logService, response, finishCallback, telemetryData);
		} else if (!this._supportsStreaming) {
			return defaultNonStreamChatResponseProcessor(response, finishCallback, telemetryData);
		} else {
			return defaultChatResponseProcessor(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);
		}
	}

	public async acceptChatPolicy(): Promise<boolean> {
		if (this.policy === 'enabled') {
			return true;
		}
		try {
			const response = await postRequest(
				this._fetcherService,
				this._telemetryService,
				this._capiClientService,
				{ type: RequestType.ModelPolicy, modelId: this.model },
				(await this._authService.getCopilotToken()).token,
				await createRequestHMAC(process.env.HMAC_SECRET),
				'chat-policy',
				generateUuid(),
				{
					state: 'enabled'
				},
			);
			// Mark it enabled locally. It will be refreshed on the next fetch
			if (response.ok && this._policyDetails) {
				this._policyDetails.state = 'enabled';
			}
			return response.ok;
		} catch {
			return false;
		}
	}

	public acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer(this);
	}

	public async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		return this._makeChatRequest2({ ...options, ignoreStatefulMarker: options.ignoreStatefulMarker ?? true }, token);

		// Stateful responses API not supported for now
		// const response = await this._makeChatRequest2(options, token);
		// if (response.type === ChatFetchResponseType.InvalidStatefulMarker) {
		// 	return this._makeChatRequest2({ ...options, ignoreStatefulMarker: true }, token);
		// }
		// return response;
	}

	protected async _makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken) {
		return this._chatMLFetcher.fetchOne({
			requestOptions: {},
			...options,
			endpoint: this,
		}, token);
	}

	public async makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
	): Promise<ChatResponse> {
		return this.makeChatRequest2({
			debugName,
			messages,
			finishedCb,
			location,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
		}, token);
	}

	public cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this._instantiationService.createInstance(
			ChatEndpoint,
			mixin(deepClone(this.modelMetadata), { capabilities: { limits: { max_prompt_tokens: modelMaxPromptTokens } } }));
	}
}

export class RemoteAgentChatEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _requestMetadata: RequestMetadata,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configService: IConfigurationService,
		@IExperimentationService experimentService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			domainService,
			capiClientService,
			fetcherService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configService,
			experimentService,
			logService
		);
	}

	override processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		// We must override this to a num choices > 1 because remote agents can do internal function calls which emit multiple completions even when N > 1
		// It's awful that they do this, but we have to support it
		return defaultChatResponseProcessor(telemetryService, logService, response, 2, finishCallback, telemetryData, cancellationToken);
	}

	public override get urlOrRequestMetadata() {
		return this._requestMetadata;
	}
}
