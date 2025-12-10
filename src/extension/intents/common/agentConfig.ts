/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';


export function getAgentMaxRequests(accessor: ServicesAccessor,): number {
	const configurationService = accessor.get(IConfigurationService);
	const experimentationService = accessor.get(IExperimentationService);

	const configuredValue = configurationService.getNonExtensionConfig<number>('chat.agent.maxRequests') ?? 200; // Fallback for simulation tests

	const experimentLimit = experimentationService.getTreatmentVariable<number>('chatAgentMaxRequestsLimit');
	if (typeof experimentLimit === 'number' && experimentLimit > 0) {
		return Math.min(configuredValue, experimentLimit);
	}

	return configuredValue;
}
