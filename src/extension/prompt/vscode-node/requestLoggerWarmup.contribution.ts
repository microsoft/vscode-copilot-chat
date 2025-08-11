/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

/**
 * Ensures the IRequestLogger service is instantiated early so persistence initializes
 * and diagnostic logs are visible in the Output channel even before chat is enabled.
 */
export class RequestLoggerWarmupContribution extends Disposable implements IExtensionContribution {
	readonly id = 'requestLoggerWarmup';

	constructor(
		@IRequestLogger _requestLogger: IRequestLogger,
		@IConfigurationService _configService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();
		// Touching the service in the constructor forces instantiation via DI.
		logService.debug('[requestLogger] warmup contribution instantiated');
	}
}
