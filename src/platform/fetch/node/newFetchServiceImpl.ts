/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { BaseNewFetchService } from '../common/newFetchService';

export class NewFetchServiceImpl extends BaseNewFetchService {
	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		// Use a lazy proxy for IExperimentationService to break the circular dependency:
		// ICAPIClientService -> INewFetchService -> IExperimentationService -> ITelemetryService -> IDomainService -> ICAPIClientService
		// The experimentation service is only called at fetch time, not during construction.
		const lazyExperimentation = {
			getTreatmentVariable: <T extends boolean | number | string>(name: string) =>
				instantiationService.invokeFunction(accessor => accessor.get(IExperimentationService)).getTreatmentVariable<T>(name),
		};
		super(fetcherService, lazyExperimentation, {
			logger: logService,
			circuitBreaker: {},
		});
	}
}
