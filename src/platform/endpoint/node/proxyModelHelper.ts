/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IProxyModelsService } from '../../proxyModels/common/proxyModelsService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';

/**
 * Determines which model to use for instant apply endpoints based on proxy models service availability
 * and configuration settings.
 *
 * @param configurationService - Service for accessing configuration values
 * @param experimentationService - Service for accessing experiment flags
 * @param proxyModelsService - Service providing proxy model information
 * @param fallbackConfigKey - Configuration key to use if proxy models service is not enabled
 * @param defaultModel - Default model to use if no configuration is found
 * @returns The model name to use for the endpoint
 */
export function getInstantApplyModel(
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
	proxyModelsService: IProxyModelsService,
	fallbackConfigKey: typeof ConfigKey.Advanced.InstantApplyShortModelName | typeof ConfigKey.TeamInternal.InstantApplyModelName,
	defaultModel: string
): string {
	// Check experimental flag to determine if we should use proxy models service
	const useProxyModelsService = configurationService.getExperimentBasedConfig<boolean>(
		ConfigKey.TeamInternal.UseProxyModelsServiceForInstantApply,
		experimentationService
	);

	const instantApplyModels = useProxyModelsService ? proxyModelsService.instantApplyModels : undefined;

	return (instantApplyModels && instantApplyModels.length > 0)
		? instantApplyModels[0].name
		: configurationService.getExperimentBasedConfig<string>(fallbackConfigKey, experimentationService) ?? defaultModel;
}
