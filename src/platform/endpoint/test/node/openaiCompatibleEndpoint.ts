/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAI } from '@vscode/prompt-tsx';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { IEnvService } from '../../../env/common/envService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../../networking/common/networking';
import { CAPIChatMessage } from '../../../networking/common/openai';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../../common/capiClient';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export type IModelConfig = {
	id: string;
	name: string;
	version: string;
	type: 'openai' | 'azureOpenai';
	useDeveloperRole: boolean;
	capabilities: {
		supports: {
			parallel_tool_calls: boolean;
			streaming: boolean;
			tool_calls: boolean;
			vision: boolean;
			prediction: boolean;
		};
		limits: {
			max_prompt_tokens: number;
			max_output_tokens: number;
		};
	};
	url: string;
	apiKeyEnvName: string;
}

export class OpenAICompatibleTestEndpoint extends ChatEndpoint {
	constructor(
		private readonly modelConfig: IModelConfig,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		const modelInfo: IChatModelInformation = {
			id: modelConfig.id,
			name: modelConfig.name,
			version: modelConfig.version,
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				type: 'chat',
				family: modelConfig.type === 'azureOpenai' ? 'azure' : 'openai',
				tokenizer: TokenizerType.O200K,
				supports: {
					parallel_tool_calls: modelConfig.capabilities.supports.parallel_tool_calls,
					streaming: modelConfig.capabilities.supports.streaming,
					tool_calls: modelConfig.capabilities.supports.tool_calls,
					vision: modelConfig.capabilities.supports.vision,
					prediction: modelConfig.capabilities.supports.prediction
				},
				limits: {
					max_prompt_tokens: modelConfig.capabilities.limits.max_prompt_tokens,
					max_output_tokens: modelConfig.capabilities.limits.max_output_tokens,
				}
			}
		};

		super(
			modelInfo,
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

	override get urlOrRequestMetadata(): string {
		return this.modelConfig.url;
	}

	public getExtraHeaders(): Record<string, string> {
		const apiKey = process.env[this.modelConfig.apiKeyEnvName];
		if (!apiKey) {
			throw new Error(`API key environment variable ${this.modelConfig.apiKeyEnvName} is not set`);
		}

		if (this.modelConfig.type === 'azureOpenai') {
			return {
				"api-key": apiKey,
				"Content-Type": "application/json",
			};
		}

		return {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		};
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (this.modelConfig.type === 'azureOpenai') {
			if (body) {
				delete body.snippy;
				delete body.intent;
			}
		}

		if (this.modelConfig.useDeveloperRole && body) {
			const newMessages = body.messages!.map((message: CAPIChatMessage) => {
				if (message.role === OpenAI.ChatRole.System) {
					return { role: 'developer' as OpenAI.ChatRole.System, content: message.content };
				}
				return message;
			});
			Object.keys(body).forEach(key => delete (body as any)[key]);
			body.model = this.modelConfig.id; //TODO: is id the right field?
			body.messages = newMessages;
			body.stream = false;
		}
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(_modelMaxPromptTokens: number): IChatEndpoint {
		return this.instantiationService.createInstance(OpenAICompatibleTestEndpoint, this.modelConfig);
	}
}
