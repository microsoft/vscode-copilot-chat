/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Specialized endpoint for Ollama models.
 * Ollama uses a JSON-lines streaming format instead of SSE,
 * and this class serves as a marker to ensure the correct response processor is used.
 */
export class OllamaChatEndpoint extends OpenAIEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		apiKey: string,
		modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			apiKey,
			modelUrl,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			logService
		);
	}

	protected override get isOllamaEndpoint(): boolean {
		return true;
	}
}