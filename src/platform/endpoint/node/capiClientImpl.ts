/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvService } from '../../env/common/envService';
import { INewFetchService } from '../../fetch/common/newFetchService';
import { BaseCAPIClientService } from '../common/capiClient';

export class CAPIClientImpl extends BaseCAPIClientService {

	constructor(
		@IEnvService envService: IEnvService,
		@INewFetchService newFetchService: INewFetchService,
	) {
		super(
			process.env.HMAC_SECRET,
			process.env.VSCODE_COPILOT_INTEGRATION_ID,
			envService,
			newFetchService,
		);
	}
}