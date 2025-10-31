/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperimentationService } from '../../../../../platform/telemetry/common/nullExperimentationService';

export class CompletionsExperimentationServiceBridge {
	constructor(
		@IExperimentationService public readonly experimentationService: IExperimentationService
	) { }
}