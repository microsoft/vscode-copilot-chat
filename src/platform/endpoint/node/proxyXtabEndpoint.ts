/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { CHAT_MODEL, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { IThinkingDataService } from '../../thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export class ProxyXtabEndpoint extends ChatEndpoint {

	private static chatModelInfo: IChatModelInformation = {
		id: CHAT_MODEL.NES_XTAB,
		name: 'xtab-proxy',
		model_picker_enabled: false,
		is_chat_default: false,
		is_chat_fallback: false,
		version: 'unknown',
		capabilities: {
			type: 'chat',
			family: 'xtab-proxy',
			tokenizer: TokenizerType.O200K,
			limits: {
				max_prompt_tokens: 12285,
				max_output_tokens: 4096,
			},
			supports: {
				streaming: true,
				parallel_tool_calls: false,
				tool_calls: false,
				vision: false,
				prediction: true,
			}
		}
	};

	constructor(
		overriddenModelName: string | undefined,
		@IConfigurationService _configService: IConfigurationService,
		@IExperimentationService _experimentationService: IExperimentationService,
		@IDomainService _domainService: IDomainService,
		@IFetcherService _fetcherService: IFetcherService,
		@ICAPIClientService _capiClientService: ICAPIClientService,
		@IEnvService _envService: IEnvService,
		@ITelemetryService _telemetryService: ITelemetryService,
		@IAuthenticationService _authService: IAuthenticationService,
		@IChatMLFetcher _chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider _tokenizerProvider: ITokenizerProvider,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IThinkingDataService _thinkingDataService: IThinkingDataService,
	) {
		const chatModelInfo = overriddenModelName === undefined
			? ProxyXtabEndpoint.chatModelInfo
			: {
				...ProxyXtabEndpoint.chatModelInfo,
				id: overriddenModelName
			};
		super(
			chatModelInfo,
			_domainService,
			_capiClientService,
			_fetcherService,
			_envService,
			_telemetryService,
			_authService,
			_chatMLFetcher,
			_tokenizerProvider,
			_instantiationService,
			_thinkingDataService
		);
	}

	override get urlOrRequestMetadata() {
		return { type: RequestType.ProxyChatCompletions };
	}
}
