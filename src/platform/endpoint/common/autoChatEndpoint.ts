/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RequestMetadata } from '@vscode/copilot-api';
import { ChatMessage } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { CancellationToken } from 'vscode';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IntentParams, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { ChatCompletion } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';

/**
 * This endpoint represents the "Auto" model in the model picker.
 * It just effectively wraps a different endpoint and adds the auto stuff on top
 */
export class AutoChatEndpoint implements IChatEndpoint {
	public static readonly id = 'auto';
	maxOutputTokens: number = this._wrappedEndpoint.maxOutputTokens;
	model: string = AutoChatEndpoint.id;
	supportsToolCalls: boolean = this._wrappedEndpoint.supportsToolCalls;
	supportsVision: boolean = this._wrappedEndpoint.supportsVision;
	supportsPrediction: boolean = this._wrappedEndpoint.supportsPrediction;
	showInModelPicker: boolean = true;
	isPremium?: boolean | undefined = this._wrappedEndpoint.isPremium;
	multiplier?: number | undefined = this._wrappedEndpoint.multiplier;
	restrictedToSkus?: string[] | undefined = this._wrappedEndpoint.restrictedToSkus;
	isDefault: boolean = this._wrappedEndpoint.isDefault;
	isFallback: boolean = this._wrappedEndpoint.isFallback;
	policy: 'enabled' | { terms: string } = this._wrappedEndpoint.policy;
	urlOrRequestMetadata: string | RequestMetadata = this._wrappedEndpoint.urlOrRequestMetadata;
	modelMaxPromptTokens: number = this._wrappedEndpoint.modelMaxPromptTokens;
	name: string = this._wrappedEndpoint.name;
	version: string = this._wrappedEndpoint.version;
	family: string = this._wrappedEndpoint.family;
	tokenizer: TokenizerType = this._wrappedEndpoint.tokenizer;

	constructor(
		private readonly _wrappedEndpoint: IChatEndpoint,
		private readonly _sessionToken: string
	) { }

	getExtraHeaders(): Record<string, string> {
		return {
			...(this._wrappedEndpoint.getExtraHeaders?.() || {}),
			'Copilot-Session-Token': this._sessionToken
		};
	}

	processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken): Promise<AsyncIterableObject<ChatCompletion>> {
		return this._wrappedEndpoint.processResponseFromChatEndpoint(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);
	}
	acceptChatPolicy(): Promise<boolean> {
		return this._wrappedEndpoint.acceptChatPolicy();
	}
	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this._wrappedEndpoint.cloneWithTokenOverride(modelMaxPromptTokens);
	}
	acquireTokenizer(): ITokenizer {
		return this._wrappedEndpoint.acquireTokenizer();
	}

	async makeChatRequest(debugName: string, messages: ChatMessage[], finishedCb: FinishedCallback | undefined, token: CancellationToken, location: ChatLocation, source?: Source, requestOptions?: Omit<OptionalChatRequestParams, 'n'>, userInitiatedRequest?: boolean, telemetryProperties?: TelemetryProperties, intentParams?: IntentParams): Promise<ChatResponse> {
		return this._wrappedEndpoint.makeChatRequest(debugName, messages, finishedCb, token, location, source, requestOptions, userInitiatedRequest, telemetryProperties, intentParams);
	}
}

/**
 * Checks if the auto chat mode is enabled.
 * @param expService The experimentation service to use to check if the auto mode is enabled
 * @param envService The environment service to use to check if the auto mode is enabled
 * @returns True if the auto mode is enabled, false otherwise
 */
export function isAutoModeEnabled(expService: IExperimentationService, envService: IEnvService): boolean {
	return !!expService.getTreatmentVariable<boolean>('vscode', 'copilotchatcapiautomode') || envService.isPreRelease();
}