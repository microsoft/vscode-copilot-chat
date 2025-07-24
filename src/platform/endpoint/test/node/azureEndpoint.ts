/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAI } from '@vscode/prompt-tsx';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { CHAT_MODEL } from '../../../configuration/common/configurationService';
import { IEnvService } from '../../../env/common/envService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../../networking/common/networking';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { IThinkingDataService } from '../../../thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../../common/capiClient';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export class AzureTestEndpoint extends ChatEndpoint {
	private readonly isThinkingModel: boolean;
	constructor(
		private readonly _azureModel: string,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClient: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThinkingDataService private thinkingDataService: IThinkingDataService
	) {
		const modelInfo: IChatModelInformation = {
			id: _azureModel,
			name: 'Azure Test',
			version: '1.0',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				type: 'chat',
				family: 'azure',
				tokenizer: TokenizerType.O200K,
				supports: { streaming: true, tool_calls: true, vision: false, prediction: false },
				limits: {
					max_prompt_tokens: 200000,
					max_output_tokens: 56000,
				},
			}
		};
		super(
			modelInfo,
			domainService,
			capiClient,
			fetcherService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService
		);
		this.isThinkingModel = false; // Set to true if testing a thinking model
	}

	override get urlOrRequestMetadata(): string {
		switch (this._azureModel) {
			case CHAT_MODEL.EXPERIMENTAL:
				// Set model params and thinking in constructor
				return '<replace with your experimental endpoint URL>';
			default:
				throw new Error(`Unknown azure model passed ${this._azureModel} passed to test endpoint`);
		}
	}

	private getSecretKey(): string {
		let secretKey: string | undefined = '';
		switch (this._azureModel) {
			case CHAT_MODEL.EXPERIMENTAL:
				secretKey = process.env.EXPERIMENTAL_TOKEN;
				break;
			default:
				throw new Error(`Unknown azure model passed ${this._azureModel} passed to test endpoint`);
		}
		if (!secretKey) {
			throw new Error(`No secret key found for model ${this._azureModel}`);
		}
		return secretKey;
	}

	private getAuthHeader(): string {
		return 'Bearer ' + this.getSecretKey();
	}

	public getExtraHeaders(): Record<string, string> {
		return {
			'Authorization': this.getAuthHeader(),
			'ocp-apim-subscription-key': this.getSecretKey(),
			'api-key': this.getSecretKey(),
			'x-policy-id': "nil"
		};
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (body) {
			delete body.snippy;
			delete body.intent;

			if (body.messages) {
				const newMessages = body.messages.map((message: OpenAI.ChatMessage) => {
					if (message.role === OpenAI.ChatRole.Assistant && message.tool_calls && message.tool_calls.length > 0) {
						const id = message.tool_calls[0].id;
						const thinking = this.thinkingDataService.get(id);
						if (thinking?.id) {
							return {
								...message,
								cot_id: thinking.id,
								cot_summary: thinking.text,
							};
						}
					}
					return message;
				});
				body.messages = newMessages;
			}

			if (body && this.isThinkingModel) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
			}
		}
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this.instantiationService.createInstance(AzureTestEndpoint, this._azureModel);
	}
}