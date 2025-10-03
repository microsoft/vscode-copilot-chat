/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CAPIClient } from '@vscode/copilot-api';
import { createServiceIdentifier } from '../../../util/common/services';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { LICENSE_AGREEMENT } from './licenseAgreement';

/**
 * Interface for CAPI client service
 */
export interface ICAPIClientService extends CAPIClient {
	readonly _serviceBrand: undefined;
}

export abstract class BaseCAPIClientService extends CAPIClient implements ICAPIClientService {
	readonly _serviceBrand: undefined;

	constructor(
		hmac: string | undefined,
		forceDevMode: boolean,
		fetcherService: IFetcherService,
		envService: IEnvService
	) {
		super({
			machineId: envService.machineId,
			sessionId: envService.sessionId,
			vscodeVersion: envService.vscodeVersion,
			buildType: envService.getBuildType(),
			name: envService.getName(),
			version: envService.getVersion(),
		}, LICENSE_AGREEMENT, fetcherService, hmac, forceDevMode);
	}
}
export const ICAPIClientService = createServiceIdentifier<ICAPIClientService>('ICAPIClientService');
