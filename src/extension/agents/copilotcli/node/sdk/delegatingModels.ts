/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Lazy } from '../../../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotCLIModelInfo, CopilotCLIModels, ICopilotCLIModels } from '../copilotCli';
import { ICopilotCLISDKSelector } from '../copilotCliSdkSelector';
import { NewSdkCopilotCLIModels } from './copilotcliModels';

/**
 * Lazily creates either a CopilotCLIModels or NewSdkCopilotCLIModels instance
 * based on the ICopilotCLISDKSelector.useGithubCopilotSDK() result.
 * The SDK selector is evaluated once on first access; changes require a VS Code reload.
 */
export class DelegatingCopilotCLIModels implements ICopilotCLIModels {
	declare _serviceBrand: undefined;

	private readonly _service: Lazy<Promise<ICopilotCLIModels>>;

	constructor(
		@ICopilotCLISDKSelector sdkSelector: ICopilotCLISDKSelector,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this._service = new Lazy(async () => {
			const useNewSdk = await sdkSelector.useGithubCopilotSDK();
			return useNewSdk
				? instantiationService.createInstance(NewSdkCopilotCLIModels)
				: instantiationService.createInstance(CopilotCLIModels);
		});
	}

	async resolveModel(modelId: string): Promise<string | undefined> {
		const service = await this._service.value;
		return service.resolveModel(modelId);
	}

	async getDefaultModel(): Promise<string | undefined> {
		const service = await this._service.value;
		return service.getDefaultModel();
	}

	async setDefaultModel(modelId: string | undefined): Promise<void> {
		const service = await this._service.value;
		return service.setDefaultModel(modelId);
	}

	async getModels(): Promise<CopilotCLIModelInfo[]> {
		const service = await this._service.value;
		return service.getModels();
	}
}
