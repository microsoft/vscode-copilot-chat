/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from 'vscode';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';

export class GithubTelemetryForwardingContrib extends Disposable implements IExtensionContribution {
	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		const channel = env.getDataChannel<IEditTelemetryData>('editTelemetry');
		this._register(channel.onDidReceiveData((args) => {
			const { properties, measurements } = dataToPropsAndMeasurements(args.data.data);
			this._telemetryService.sendGHTelemetryEvent('vscode.' + args.data.eventName, properties, measurements);
		}));
	}
}

function dataToPropsAndMeasurements(data: Record<string, unknown>): { properties: Record<string, string>; measurements: Record<string, number> } {
	const properties: Record<string, string> = {};
	const measurements: Record<string, number> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === 'number') {
			measurements[key] = value;
		} else if (typeof value === 'string') {
			properties[key] = value;
		}
	}
	return { properties, measurements };
}

interface IEditTelemetryData {
	eventName: string;
	data: Record<string, unknown>;
}
