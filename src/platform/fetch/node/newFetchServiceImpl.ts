/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { BaseNewFetchService } from '../common/newFetchService';

export class NewFetchServiceImpl extends BaseNewFetchService {
	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILogService logService: ILogService,
	) {
		super(fetcherService, experimentationService, {
			logger: logService,
			circuitBreaker: {},
		});
	}
}
