/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface ICopilotCLISDKSelector {
	readonly _serviceBrand: undefined;
	useGithubCopilotSDK(): Promise<boolean>;
}

export const ICopilotCLISDKSelector = createServiceIdentifier<ICopilotCLISDKSelector>('ICopilotCLISDKSelector');

export class CopilotCLISDKSelector implements ICopilotCLISDKSelector {
	declare _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async useGithubCopilotSDK(): Promise<boolean> {
		return this.configurationService.getConfig(ConfigKey.Advanced.CLINewSdkEnabled) ?? false;
	}
}
