/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { CancellationToken } from 'vscode';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IntentParams, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { ChatCompletion } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IEndpointProvider } from '../common/endpointProvider';

/**
 * This endpoint represents the "Auto" model in the model picker.
 * It is just a shell class used to register with the `lm` API so it shows up in the model picker.
 * The actual model resolution is done in `src/extension/prompt/vscode-node/endpointProviderImpl.ts`.
 */
export class AutoChatEndpoint implements IChatEndpoint {
	public static readonly id = 'auto';
	maxOutputTokens: number = 8192;
	model: string = AutoChatEndpoint.id;
	supportsToolCalls: boolean = true;
	supportsVision: boolean = true;
	supportsPrediction: boolean = true;
	showInModelPicker: boolean = true;
	isPremium?: boolean | undefined = false;
	multiplier?: number | undefined = undefined;
	restrictedToSkus?: string[] | undefined = undefined;
	isDefault: boolean = false;
	isFallback: boolean = false;
	policy: 'enabled' | { terms: string } = 'enabled';
	urlOrRequestMetadata: string = '';
	modelMaxPromptTokens: number = 64000;
	name: string = 'Auto';
	version: string = 'auto';
	family: string = 'auto';
	tokenizer: TokenizerType = TokenizerType.O200K;

	constructor(
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
		@IExperimentationService private readonly _expService: IExperimentationService,
	) {
	}

	processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken): Promise<AsyncIterableObject<ChatCompletion>> {
		throw new Error('Method not implemented.');
	}
	acceptChatPolicy(): Promise<boolean> {
		throw new Error('Method not implemented.');
	}
	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		throw new Error('Method not implemented.');
	}
	acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer({ tokenizer: TokenizerType.O200K });
	}

	async makeChatRequest(debugName: string, messages: ChatMessage[], finishedCb: FinishedCallback | undefined, token: CancellationToken, location: ChatLocation, source?: Source, requestOptions?: Omit<OptionalChatRequestParams, 'n'>, userInitiatedRequest?: boolean, telemetryProperties?: TelemetryProperties, intentParams?: IntentParams): Promise<ChatResponse> {
		// This is only ever called from LM chat extensions.
		//  Copilot Chat 1st party requests instead get the endpoint much earlier and never call `makeChatRequest` on this endpoint but instead the actual one
		// What copilot Chat does is more correct, but it's difficult to do this in the LM API
		const endpoint = await resolveAutoChatEndpoint(this._endpointProvider, this._expService, undefined);
		return endpoint.makeChatRequest(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
			intentParams,
		);
	}
}

/**
 * Checks if the auto chat mode is enabled.
 * @param expService The experimentation service to use to check if the auto mode is enabled
 * @returns True if the auto mode is enabled, false otherwise
 */
export function isAutoModeEnabled(expService: IExperimentationService): boolean {
	return !!expService.getTreatmentVariable<string>('vscode', 'copilotchatautomodel');
}

/**
 * Resolves the auto chat endpoint to hte backing chat endpoint.
 * @param endpointProvider The endpoint provider to use to get the chat endpoints
 * @returns The endpoint that should be used for the auto chat model
 */
export async function resolveAutoChatEndpoint(
	endpointProvider: IEndpointProvider,
	expService: IExperimentationService,
	userPrompt: string | undefined,
): Promise<IChatEndpoint> {
	const modelId = expService.getTreatmentVariable<string>('vscode', 'copilotchatautomodel');
	const endpoint = (await endpointProvider.getAllChatEndpoints()).find(e => e.model === modelId) || await endpointProvider.getChatEndpoint('copilot-base');
	return endpoint;
}