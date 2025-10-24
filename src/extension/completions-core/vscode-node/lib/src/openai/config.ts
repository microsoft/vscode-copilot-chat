/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { CompletionHeaders } from './fetch';
import { AvailableModelsManager, ModelChoiceSourceTelemetryValue } from './model';
import { TelemetryWithExp } from '../telemetry';
import { TokenizerName } from '../../../prompt/src/tokenization';

// Config methods

export type EngineRequestInfo = {
	headers: CompletionHeaders;
	modelId: string;
	engineChoiceSource: ModelChoiceSourceTelemetryValue;
	tokenizer: TokenizerName;
};

export function getEngineRequestInfo(
	ctx: Context,
	telemetryData: TelemetryWithExp | undefined = undefined
): EngineRequestInfo {
	const modelsManager = ctx.get(AvailableModelsManager);
	const modelRequestInfo = modelsManager.getCurrentModelRequestInfo(telemetryData);
	const tokenizer = modelsManager.getTokenizerForModel(modelRequestInfo.modelId);

	return {
		headers: modelRequestInfo.headers,
		modelId: modelRequestInfo.modelId,
		engineChoiceSource: modelRequestInfo.modelChoiceSource,
		tokenizer,
	};
}
