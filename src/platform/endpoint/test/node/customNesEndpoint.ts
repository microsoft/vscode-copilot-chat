/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TokenizerType } from '../../../../util/common/tokenizer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { CHAT_MODEL, IConfigurationService } from '../../../configuration/common/configurationService';
import { ILogService } from '../../../log/common/logService';
import { IEndpointBody } from '../../../networking/common/networking';
import { IExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { IDomainService } from '../../common/domainService';
import { IChatModelInformation } from '../../common/endpointProvider';
import { ChatEndpoint } from '../../node/chatEndpoint';

export class CustomNesEndpoint extends ChatEndpoint {
	constructor(
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		const modelInfo: IChatModelInformation = {
			id: CHAT_MODEL.CUSTOM_NES,
			name: 'custom-nes',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			version: 'unknown',
			capabilities: {
				type: 'chat',
				family: 'custom-nes',
				tokenizer: TokenizerType.O200K,
				limits: {
					// TODO@ulugbekna: copied from CAPI's 4o-mini
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

	override get urlOrRequestMetadata(): string {
		const url = process.env.CUSTOM_NES_URL;
		if (!url) {
			throw new Error(`No url found for custom NES model`);
		}
		return url;
	}

	private getSecretKey(): string {
		const secretKey: string | undefined = process.env.CUSTOM_NES_TOKEN;
		if (!secretKey) {
			throw new Error(`No secret key found for custom NES model`);
		}
		return secretKey;
	}

	private getAuthHeader(): string {
		return 'Bearer ' + this.getSecretKey();
	}

	public override getExtraHeaders(): Record<string, string> {
		return {
			'Authorization': this.getAuthHeader(),
			'api-key': this.getSecretKey(),
		};
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (body) {
			delete body.snippy;
			delete body.intent;
		}
	}
}
