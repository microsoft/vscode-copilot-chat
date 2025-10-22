/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { ExpTreatmentVariables } from '../experiments/expConfig';
import { getEngineRequestInfo } from './config';
import { TelemetryWithExp } from '../telemetry';
import { createLibTestingContext } from '../testing/context';
import * as assert from 'assert';

suite('OpenAI Config Tests', function () {
	let ctx: Context;

	setup(function () {
		ctx = createLibTestingContext();
	});

	test('getEngineRequestInfo() returns the model from AvailableModelManager', function () {
		const telem = TelemetryWithExp.createEmptyConfigForTesting();
		telem.filtersAndExp.exp.variables[ExpTreatmentVariables.CustomEngine] = 'model.override';

		const info = getEngineRequestInfo(ctx, telem);

		assert.strictEqual(info.modelId, 'model.override');
		assert.deepStrictEqual(info.headers, {});
	});
});
