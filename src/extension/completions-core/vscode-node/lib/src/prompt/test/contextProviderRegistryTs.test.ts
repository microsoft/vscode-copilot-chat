/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ICompletionsContextService } from '../../context';
import { TelemetryWithExp } from '../../telemetry';
import { createLibTestingContext } from '../../test/context';
import { ActiveExperiments } from '../contextProviderRegistry';
import { fillInTsActiveExperiments, TS_CONTEXT_PROVIDER_ID } from '../contextProviderRegistryTs';

suite('contextProviderRegistryTs', function () {
	let ctx: ICompletionsContextService;
	let activeExperiments: ActiveExperiments;
	let telemetryData: TelemetryWithExp;

	setup(function () {
		ctx = createLibTestingContext();
		activeExperiments = new Map();
		telemetryData = TelemetryWithExp.createEmptyConfigForTesting();
		telemetryData.filtersAndExp.exp.variables['copilottscontextproviderparams'] = JSON.stringify({
			booleanProperty: true,
		});
	});

	test('does not add active experiments if no provider is active', function () {
		fillInTsActiveExperiments(ctx, [], activeExperiments, telemetryData);

		assert.ok(activeExperiments.size === 0);
	});

	test('adds active experiments if TS provider is active', function () {
		fillInTsActiveExperiments(ctx, [TS_CONTEXT_PROVIDER_ID], activeExperiments, telemetryData);

		assert.ok(activeExperiments.has('booleanProperty'));
		assert.strictEqual(activeExperiments.get('booleanProperty'), true);
	});

	test('adds active experiments in debug mode', function () {
		fillInTsActiveExperiments(ctx, ['*'], activeExperiments, telemetryData);

		assert.ok(activeExperiments.has('booleanProperty'));
		assert.strictEqual(activeExperiments.get('booleanProperty'), true);
	});

	test('bad JSON is ignored', function () {
		telemetryData.filtersAndExp.exp.variables['copilottscontextproviderparams'] = '{"badJSON": true';

		fillInTsActiveExperiments(ctx, [TS_CONTEXT_PROVIDER_ID], activeExperiments, telemetryData);

		assert.ok(activeExperiments.size === 0);
	});
});
