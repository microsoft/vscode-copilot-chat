/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { CHAT_MODEL, EMBEDDING_MODEL } from '../../../configuration/common/configurationService';
import { IEnvService } from '../../../env/common/envService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../../common/capiClient';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export class CAPITestEndpoint extends ChatEndpoint {

	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _isModelLablModel: boolean,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(modelMetadata,
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

	override get urlOrRequestMetadata() {
		if (this._isModelLablModel) {
			return { type: RequestType.ChatCompletions, isModelLab: true };
		} else {
			return super.urlOrRequestMetadata;
		}
	}
}

/**
 * Since tests don't have the full fledged model metadata output from `/models` we need to manually map the model to the correct tokenizer
 * @param model The model to find the tokenizer for
 * @returns The tokenizer
 */
export function modelIdToTokenizer(model: string | EMBEDDING_MODEL): TokenizerType {
	switch (model) {
		case CHAT_MODEL.GPT41:
		case CHAT_MODEL.GPT4OMINI:
		case CHAT_MODEL.GPT4OPROXY:
		case CHAT_MODEL.EXPERIMENTAL:
		case CHAT_MODEL.O1:
		case CHAT_MODEL.O1MINI:
		default:
			return TokenizerType.O200K;
	}
}
