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
import { IThinkingDataService } from '../../../thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../../common/capiClient';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export class OpenAITestEndpoint extends ChatEndpoint {
	constructor(
		private readonly _openaiModel: string,
		private readonly _openaiAPIKey: string,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThinkingDataService thinkingDataService: IThinkingDataService
	) {
		const modelInfo: IChatModelInformation = {
			id: _openaiModel,
			name: 'Open AI Test Model',
			version: '20250108',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				type: 'chat',
				family: 'openai',
				tokenizer: TokenizerType.O200K,
				supports: { streaming: false, tool_calls: true, vision: false, prediction: false },
				limits: {
					max_prompt_tokens: 128000,
					max_output_tokens: Number.MAX_SAFE_INTEGER,
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
			instantiationService,
			thinkingDataService,
		);
	}

	override get urlOrRequestMetadata(): string {
		return 'https://api.openai.com/v1/chat/completions';
	}

	public getExtraHeaders(): Record<string, string> {
		return {
			"Authorization": `Bearer ${this._openaiAPIKey}`,
			"Content-Type": "application/json",
		};
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		if (!body) {
			return;
		}
		const newMessages = body.messages!.map((message: CAPIChatMessage) => {
			if (message.role === OpenAI.ChatRole.System) {
				return { role: 'developer' as OpenAI.ChatRole.System, content: message.content };
			}
			return message;
		});
		Object.keys(body).forEach(key => delete (body as any)[key]);
		body.model = this._openaiModel;
		body.messages = newMessages;
		body.stream = false;
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this.instantiationService.createInstance(OpenAITestEndpoint, this._openaiModel, this._openaiAPIKey);
	}
}
