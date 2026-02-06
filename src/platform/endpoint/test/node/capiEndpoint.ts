/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../configuration/common/configurationService';
import { ILogService } from '../../../log/common/logService';
import { IExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export class CAPITestEndpoint extends ChatEndpoint {

	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _isModelLablModel: boolean,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(modelMetadata,
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
		if (this._isModelLablModel) {
			return { type: RequestType.ChatCompletions, isModelLab: true };
		} else {
			return super.urlOrRequestMetadata;
		}
	}
}
