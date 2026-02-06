/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { IProxyModelsService } from '../../proxyModels/common/proxyModelsService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';
import { getInstantApplyModel } from './proxyModelHelper';

export class Proxy4oEndpoint extends ChatEndpoint {

	_serviceBrand: undefined;

	constructor(
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService,
		@IProxyModelsService proxyModelsService: IProxyModelsService,
	) {
		const model = getInstantApplyModel(
			configurationService,
			experimentationService,
			proxyModelsService,
			ConfigKey.TeamInternal.InstantApplyModelName,
		);

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
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentationService,
			logService
		);
	}

	public override getExtraHeaders(): Record<string, string> {
		return {};
	}


	override get urlOrRequestMetadata() {
		return { type: RequestType.ProxyChatCompletions };
	}
}
