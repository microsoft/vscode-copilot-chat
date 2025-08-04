/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RequestMetadata, RequestType } from '@vscode/copilot-api';
import { OpenAI, Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { createRequestHMAC } from '../../../util/common/crypto';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { deepClone, mixin } from '../../../util/vs/base/common/objects';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher, IntentParams, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { getTextPart } from '../../chat/common/globalStringUtils';
import { CHAT_MODEL, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, ICopilotToolCall, OptionalChatRequestParams } from '../../networking/common/fetch';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody, postRequest } from '../../networking/common/networking';
import { CAPIChatMessage, ChatCompletion, FinishedCompletionReason } from '../../networking/common/openai';
import { prepareChatCompletionForReturn } from '../../networking/node/chatStream';
import { SSEProcessor } from '../../networking/node/stream';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation, ModelPolicy } from '../common/endpointProvider';

// get ChatMaxNumTokens from config for experimentation
export function getMaxPromptTokens(configService: IConfigurationService, expService: IExperimentationService, chatModelInfo: IChatModelInformation): number {
	// check debug override ChatMaxTokenNum
	const chatMaxTokenNumOverride = configService.getConfig(ConfigKey.Internal.DebugOverrideChatMaxTokenNum); // can only be set by internal users
	// Base 3 tokens for each OpenAI completion
	let modelLimit = -3;
	// if option is set, takes precedence over any other logic
	if (chatMaxTokenNumOverride > 0) {
		modelLimit += chatMaxTokenNumOverride;
		return modelLimit;
	}

	let experimentalOverrides: Record<string, number> = {};
	try {
		const expValue = expService.getTreatmentVariable<string>('vscode', 'copilotchat.contextWindows');
		experimentalOverrides = JSON.parse(expValue ?? '{}');
	} catch {
		// If the experiment service either is not available or returns a bad value we ignore the overrides
	}

	// If there's an experiment that takes precedence over what comes back from CAPI
	if (experimentalOverrides[chatModelInfo.id]) {
		modelLimit += experimentalOverrides[chatModelInfo.id];
		return modelLimit;
	}

	// Check if CAPI has promot token limits and return those
	if (chatModelInfo.capabilities?.limits?.max_prompt_tokens) {
		modelLimit += chatModelInfo.capabilities.limits.max_prompt_tokens;
		return modelLimit;
	} else if (chatModelInfo.capabilities.limits?.max_context_window_tokens) {
		// Otherwise return the context window as the prompt tokens for cases where CAPI doesn't configure the prompt tokens
		modelLimit += chatModelInfo.capabilities.limits.max_context_window_tokens;
		return modelLimit;
	}

	return modelLimit;
}

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
		const message: Raw.AssistantChatMessage = choice.message;
		const messageText = getTextPart(message.content);
		const requestId = response.headers.get('X-Request-ID') ?? generateUuid();


		const completion: ChatCompletion = {
			blockFinished: false,
			choiceIndex: i,
			filterReason: undefined,
			finishReason: choice.finish_reason as FinishedCompletionReason,
			message: message,
			usage: jsonResponse.usage,
			tokens: [], // This is used for repetition detection so not super important to be accurate
			requestId: { headerRequestId: requestId, completionId: jsonResponse.id, created: jsonResponse.created, deploymentId: '', serverExperiments: '' },
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
	private readonly _urlOrRequestMetadata: string | RequestMetadata;
	private readonly _maxTokens: number;
	private readonly _maxOutputTokens: number;
	public readonly model: string;
	public readonly name: string;
	public readonly version: string;
	public readonly family: string;
	public readonly tokenizer: TokenizerType;
	public readonly showInModelPicker: boolean;
	public readonly isDefault: boolean;
	public readonly isFallback: boolean;
	public readonly supportsToolCalls: boolean;
	public readonly supportsVision: boolean;
	public readonly supportsPrediction: boolean;
	public readonly isPremium?: boolean | undefined;
	public readonly multiplier?: number | undefined;
	public readonly restrictedToSkus?: string[] | undefined;
	private readonly _supportsStreaming: boolean;
	private _policyDetails: ModelPolicy | undefined;

	constructor(
		private readonly _modelMetadata: IChatModelInformation,
		@IDomainService protected readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IEnvService private readonly _envService: IEnvService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IChatMLFetcher private readonly _chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this._urlOrRequestMetadata = _modelMetadata.urlOrRequestMetadata ?? { type: RequestType.ChatCompletions };
		// This metadata should always be present, but if not we will default to 8192 tokens
		this._maxTokens = _modelMetadata.capabilities.limits?.max_prompt_tokens ?? 8192;
		// This metadata should always be present, but if not we will default to 4096 tokens
		this._maxOutputTokens = _modelMetadata.capabilities.limits?.max_output_tokens ?? 4096;
		this.model = _modelMetadata.id;
		this.name = _modelMetadata.name;
		this.version = _modelMetadata.version;
		this.family = _modelMetadata.capabilities.family;
		this.tokenizer = _modelMetadata.capabilities.tokenizer;
		this.showInModelPicker = _modelMetadata.model_picker_enabled;
		this.isPremium = _modelMetadata.billing?.is_premium;
		this.multiplier = _modelMetadata.billing?.multiplier;
		this.restrictedToSkus = _modelMetadata.billing?.restricted_to;
		this.isDefault = _modelMetadata.is_chat_default;
		this.isFallback = _modelMetadata.is_chat_fallback;
		this.supportsToolCalls = !!_modelMetadata.capabilities.supports.tool_calls;
		this.supportsVision = !!_modelMetadata.capabilities.supports.vision;
		this.supportsPrediction = !!_modelMetadata.capabilities.supports.prediction;
		this._supportsStreaming = !!_modelMetadata.capabilities.supports.streaming;
		this._policyDetails = _modelMetadata.policy;
	}

	public get modelMaxPromptTokens(): number {
		return this._maxTokens;
	}

	public get maxOutputTokens(): number {
		return this._maxOutputTokens;
	}

	public get urlOrRequestMetadata(): string | RequestMetadata {
		return this._urlOrRequestMetadata;
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

	public async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		if (!this._supportsStreaming) {
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
				this._envService,
				this._telemetryService,
				this._domainService,
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
		intentParams?: IntentParams
	): Promise<ChatResponse> {
		return this._chatMLFetcher.fetchOne(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			this,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
			intentParams
		);
	}

	public cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this._instantiationService.createInstance(
			ChatEndpoint,
			mixin(deepClone(this._modelMetadata), { capabilities: { limits: { max_prompt_tokens: modelMaxPromptTokens } } }));
	}
}

export class RemoteAgentChatEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _requestMetadata: RequestMetadata,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			modelMetadata,
			domainService,
			capiClientService,
			fetcherService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService
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
