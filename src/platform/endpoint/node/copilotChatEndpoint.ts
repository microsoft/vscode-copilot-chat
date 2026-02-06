/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { RawMessageConversionCallback } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export class CopilotChatEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentService,
			logService
		);
	}

	protected override getCompletionsCallback(): RawMessageConversionCallback | undefined {
		return (out, data) => {
			if (data && data.id) {
				out.reasoning_opaque = data.id;
				out.reasoning_text = Array.isArray(data.text) ? data.text.join('') : data.text;
			}
		};
	}
}
