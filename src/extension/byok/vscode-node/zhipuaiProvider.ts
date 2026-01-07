/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class ZhipuAILMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'ZhipuAI';

	// 智谱 GLM-4.7 模型配置
	private static readonly DEFAULT_MODELS: BYOKKnownModels = {
		'glm-4.7': {
			name: 'GLM-4.7',
			maxInputTokens: 200000,  // 200K 上下文窗口
			maxOutputTokens: 128000, // 128K 最大输出
			toolCalling: true,
			vision: false,
			thinking: false
		}
	};

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			ZhipuAILMProvider.providerName,
			'https://open.bigmodel.cn/api/paas/v4',
			{ ...ZhipuAILMProvider.DEFAULT_MODELS, ...knownModels },
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		// 直接返回智谱 GLM-4.7 模型配置，不需要从 API 获取
		return ZhipuAILMProvider.DEFAULT_MODELS;
	}

	protected override async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		const modelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);
		modelInfo.supported_endpoints = [
			ModelSupportedEndpoint.ChatCompletions
		];

		return modelInfo;
	}
}
