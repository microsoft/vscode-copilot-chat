/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientHttp2Stream } from 'http2';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback } from '../../../platform/networking/common/fetch';
import { Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { OpenAIEndpoint } from './openAIEndpoint';
import type { OpenAI } from 'openai';


export class OpenAIResponsesEndpoint extends OpenAIEndpoint {
	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this._modelInfo, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIResponsesEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	public override async processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken | undefined): Promise<AsyncIterableObject<ChatCompletion>> {
		const body = (await response.body()) as ClientHttp2Stream;
		return new AsyncIterableObject<ChatCompletion>(async feed => {
			const parser = new SSEParser(() => {

			});

			for await (const chunk of body) {
				parser.feed(chunk);
			}
		}, () => {
			body.destroy();
		});
	}
}

class OpenAIResponsesProcessor {
	public push(chunk: OpenAI.Responses)
}
