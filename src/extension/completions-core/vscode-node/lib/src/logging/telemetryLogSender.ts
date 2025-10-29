/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICompletionsContextService } from '../context';
import { TelemetryLogSender } from '../logger';
import { telemetryException } from '../telemetry';

export class TelemetryLogSenderImpl extends TelemetryLogSender {
	sendException(ctx: ICompletionsContextService, error: unknown, origin: string) {
		telemetryException(ctx, error, origin);
	}
}
