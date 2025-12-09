/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { CHAT_MODEL, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IProxyModelsService } from '../../proxyModels/common/proxyModelsService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export class ProxyInstantApplyShortEndpoint extends ChatEndpoint {

	constructor(
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService,
		@IProxyModelsService proxyModelsService: IProxyModelsService,
	) {
		// Check experimental flag to determine if we should use proxy models service
		const useProxyModelsService = configurationService.getExperimentBasedConfig<boolean>(ConfigKey.TeamInternal.UseProxyModelsServiceForInstantApply, experimentationService);
		const instantApplyModels = useProxyModelsService ? proxyModelsService.instantApplyModels : undefined;
		const model = (instantApplyModels && instantApplyModels.length > 0)
			? instantApplyModels[0].name
			: configurationService.getExperimentBasedConfig<string>(ConfigKey.Advanced.InstantApplyShortModelName, experimentationService) ?? CHAT_MODEL.SHORT_INSTANT_APPLY;
		const modelInfo: IChatModelInformation = {
			id: model,
			name: model,
			version: 'unknown',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				type: 'chat',
				family: model,
				tokenizer: TokenizerType.O200K,
				supports: { streaming: true, parallel_tool_calls: false, tool_calls: false, vision: false, prediction: true },
				limits: {
					max_prompt_tokens: 128000,
					max_output_tokens: 16000,
				}
			}
		};
		super(
			modelInfo,
			domainService,
			capiClientService,
			fetcherService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentationService,
			logService
		);
	}

	public override getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		if (this.authService.speculativeDecodingEndpointToken) {
			headers['Copilot-Edits-Session'] = this.authService.speculativeDecodingEndpointToken;
		}
		return headers;
	}

	override get urlOrRequestMetadata() {
		return { type: RequestType.ProxyChatCompletions };
	}
}
