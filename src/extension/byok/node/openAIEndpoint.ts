/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { isOpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { createCapiRequestBody, IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { RawMessageConversionCallback } from '../../../platform/networking/common/openai';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

function hydrateBYOKErrorMessages(response: ChatResponse): ChatResponse {
	if (response.type === ChatFetchResponseType.Failed && response.streamError) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: JSON.stringify(response.streamError),
		};
	} else if (response.type === ChatFetchResponseType.RateLimited) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: response.capiError ? 'Rate limit exceeded\n\n' + JSON.stringify(response.capiError) : 'Rate limit exceeded',
			rateLimitKey: '',
			retryAfter: undefined,
			capiError: response.capiError
		};
	}
	return response;
}

export class OpenAIEndpoint extends ChatEndpoint {
	constructor(
		protected readonly modelMetadata: IChatModelInformation,
		protected readonly _apiKey: string,
		protected readonly _modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ILogService logService: ILogService
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
			instantiationService,
			configurationService,
			expService,
			logService
		);
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		if (this.useResponsesApi) {
			// Handle Responses API: customize the body directly
			options.ignoreStatefulMarker = false;
			const body = super.createRequestBody(options);
			body.store = true;
			body.n = undefined;
			body.stream_options = undefined;
			if (!this.modelMetadata.capabilities.supports.thinking) {
				body.reasoning = undefined;
			}
			return body;
		} else {
			// Handle CAPI: provide callback for thinking data processing
			const callback: RawMessageConversionCallback = (out, data) => {
				if (data && data.id) {
					out.cot_id = data.id;
					out.cot_summary = Array.isArray(data.text) ? data.text.join('') : data.text;
				}
			};
			const body = createCapiRequestBody(options, this.model, callback);
			return body;
		}
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		// TODO @lramos15 - We should do this for all models and not just here
		if (body?.tools?.length === 0) {
			delete body.tools;
		}

		if (body?.tools) {
			body.tools = body.tools.map(tool => {
				if (isOpenAiFunctionTool(tool) && tool.function.parameters === undefined) {
					tool.function.parameters = { type: "object", properties: {} };
				}
				return tool;
			});
		}

		if (body) {
			if (this.modelMetadata.capabilities.supports.thinking) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
			}
			// Removing max tokens defaults to the maximum which is what we want for BYOK
			delete body.max_tokens;
			if (!this.useResponsesApi) {
				body['stream_options'] = { 'include_usage': true };
			}
		}
	}

	override get urlOrRequestMetadata(): string {
		return this._modelUrl;
	}

	public getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json"
		};
		if (this._modelUrl.includes('openai.azure')) {
			headers['api-key'] = this._apiKey;
		} else {
			headers['Authorization'] = `Bearer ${this._apiKey}`;
		}
		return headers;
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	public override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		// Apply ignoreStatefulMarker: false for initial request
		const modifiedOptions: IMakeChatRequestOptions = { ...options, ignoreStatefulMarker: false };
		let response = await super.makeChatRequest2(modifiedOptions, token);
		if (response.type === ChatFetchResponseType.InvalidStatefulMarker) {
			response = await this._makeChatRequest2({ ...options, ignoreStatefulMarker: true }, token);
		}
		return hydrateBYOKErrorMessages(response);
	}
}
