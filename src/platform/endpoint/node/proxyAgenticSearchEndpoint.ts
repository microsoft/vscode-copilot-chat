/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export class ProxyAgenticSearchEndpoint extends ChatEndpoint {

	constructor(
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService,
	) {
		const model = 'agentic-search-v1';
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
				supports: { streaming: true, parallel_tool_calls: true, tool_calls: true, vision: false },
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

	override get urlOrRequestMetadata() {
		return { type: RequestType.ProxyChatCompletions };
	}
}
