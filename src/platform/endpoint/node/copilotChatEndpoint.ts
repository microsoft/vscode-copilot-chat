/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { createCapiRequestBody, ICreateEndpointBodyOptions, IEndpointBody } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';
import { createResponsesRequestBody } from './responsesApi';

export class CopilotChatEndpoint extends ChatEndpoint {
	constructor(
		private readonly modelMetadata: IChatModelInformation,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
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
			capiClientService,
			fetcherService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentService,
			logService
		);
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		if (this.useResponsesApi) {
			return createResponsesRequestBody(options, this.model, this.modelMetadata);
		} else {
			return createCapiRequestBody(options, this.model, (out, data) => {
				if (data && data.id) {
					out.reasoning_opaque = data.id;
					out.reasoning_text = data.text;
				}
			});
		}
	}
}