/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType } from '../common/byokProvider';
import { BaseOpenAICompatibleBYOKRegistry } from './baseOpenAICompatibleProvider';

export class AIMEBYOKModelRegistry extends BaseOpenAICompatibleBYOKRegistry {

	constructor(
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			'AIME',
			'https://api.aime.info/v1',
			_fetcherService,
			_logService,
			_instantiationService
		);
	}
}
