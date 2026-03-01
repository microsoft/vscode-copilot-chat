/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, ExperimentBasedConfig, IConfigurationService } from '../../configuration/common/configurationService';
import { IProxyModelsService } from '../../proxyModels/common/proxyModelsService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';

/**
 * Determines which model to use for instant apply endpoints.
 */
export function getInstantApplyModel(
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
	proxyModelsService: IProxyModelsService,
	modelNameConfig: ExperimentBasedConfig<string>,
): string {
	// Check experimental flag to determine if we should use proxy models service
	const useProxyModelsService = configurationService.getExperimentBasedConfig(
		ConfigKey.TeamInternal.UseProxyModelsServiceForInstantApply,
		experimentationService
	);

	const instantApplyModels = useProxyModelsService ? proxyModelsService.instantApplyModels : undefined;

	return (instantApplyModels && instantApplyModels.length > 0)
		? instantApplyModels[0].name
		: configurationService.getExperimentBasedConfig(modelNameConfig, experimentationService);
}
