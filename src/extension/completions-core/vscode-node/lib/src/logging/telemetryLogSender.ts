/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICompletionsTelemetryService } from '../../../bridge/src/completionsTelemetryServiceBridge';
import { TelemetryLogSender } from '../logger';
import { telemetryException } from '../telemetry';

export class TelemetryLogSenderImpl extends TelemetryLogSender {
	sendException(accessor: ServicesAccessor, error: unknown, origin: string) {
		telemetryException(accessor.get(ICompletionsTelemetryService), error, origin);
	}
}
