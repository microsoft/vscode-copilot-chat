/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { OpenAI } from '@vscode/prompt-tsx';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IEndpointBody } from '../../networking/common/networking';
import { CAPIChatMessage } from '../../networking/common/openai';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { IThinkingDataService } from '../../thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export class CopilotChatEndpoint extends ChatEndpoint {
	constructor(
		readonly modelMetadata: IChatModelInformation,
		@IDomainService readonly domainService: IDomainService,
		@ICAPIClientService readonly capiClientService: ICAPIClientService,
		@IFetcherService readonly fetcherService: IFetcherService,
		@IEnvService readonly envService: IEnvService,
		@ITelemetryService readonly telemetryService: ITelemetryService,
		@IAuthenticationService readonly authService: IAuthenticationService,
		@IChatMLFetcher readonly chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider readonly tokenizerProvider: ITokenizerProvider,
		@IInstantiationService readonly instantiationService: IInstantiationService,
		@IThinkingDataService readonly thinkingDataService: IThinkingDataService,
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

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);

		if (body?.messages) {
			const newMessages: CAPIChatMessage[] = body.messages.map((message: CAPIChatMessage): CAPIChatMessage => {
				if (message.role === OpenAI.ChatRole.Assistant && message.tool_calls && message.tool_calls.length > 0) {
					const id = message.tool_calls[0].id;
					const thinking = this.thinkingDataService.get(id);
					if (thinking?.id) {
						const newMessage = {
							...message,
							reasoning_opaque: thinking.id,
							reasoning_text: thinking.text,
						};
						return newMessage;
					}
				}
				return message;
			});
			body['messages'] = newMessages;
		}
	}
}