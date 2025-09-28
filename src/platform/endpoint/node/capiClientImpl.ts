/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { BaseCAPIClientService } from '../common/capiClient';

export class CAPIClientImpl extends BaseCAPIClientService {

	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService
	) {
		super(
			process.env.HMAC_SECRET,
			!!process.env.FORCE_DEV_INTEGRATION,
			fetcherService,
			envService
		);
	}
}