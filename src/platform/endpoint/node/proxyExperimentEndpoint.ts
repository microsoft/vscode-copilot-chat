/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestMetadata } from '@vscode/copilot-api';
import { ChatMessage } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { CancellationToken } from 'vscode';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IntentParams, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../networking/common/networking';
import { ChatCompletion } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { IChatModelInformation } from '../common/endpointProvider';

export class ProxyExperimentEndpoint implements IChatEndpoint {
	public readonly showInModelPicker: boolean;
	public readonly family: string;

	constructor(
		public readonly name: string,
		public readonly model: string,
		public readonly selectedEndpoint: IChatEndpoint,
		private readonly _isDefault: boolean
	) {
		// This is a proxy endpoint that wraps another endpoint, typically used for experiments.
		// This should be used to show the endpoint in the model picker, when in experiment.
		this.showInModelPicker = true;
		this.family = this.name;

		if (selectedEndpoint.getExtraHeaders) {
			this.getExtraHeaders = selectedEndpoint.getExtraHeaders.bind(selectedEndpoint);
		}
		if (selectedEndpoint.interceptBody) {
			this.interceptBody = selectedEndpoint.interceptBody.bind(selectedEndpoint);
		}
	}

	getExtraHeaders?(): Record<string, string>;

	interceptBody?(body: IEndpointBody | undefined): void;

	get maxOutputTokens(): number {
		return this.selectedEndpoint.maxOutputTokens;
	}

	get supportsToolCalls(): boolean {
		return this.selectedEndpoint.supportsToolCalls;
	}

	get supportsVision(): boolean {
		return this.selectedEndpoint.supportsVision;
	}

	get supportsPrediction(): boolean {
		return this.selectedEndpoint.supportsPrediction;
	}

	get isPremium(): boolean | undefined {
		return this.selectedEndpoint.isPremium;
	}

	get multiplier(): number | undefined {
		return this.selectedEndpoint.multiplier;
	}

	get restrictedToSkus(): string[] | undefined {
		return this.selectedEndpoint.restrictedToSkus;
	}

	get isDefault(): boolean {
		if (this._isDefault !== undefined) {
			return this._isDefault;
		}
		return this.selectedEndpoint.isDefault;
	}

	get isFallback(): boolean {
		return this.selectedEndpoint.isFallback;
	}

	get policy(): 'enabled' | { terms: string } {
		return this.selectedEndpoint.policy;
	}

	get urlOrRequestMetadata(): string | RequestMetadata {
		return this.selectedEndpoint.urlOrRequestMetadata;
	}

	get modelMaxPromptTokens(): number {
		return this.selectedEndpoint.modelMaxPromptTokens;
	}

	get version(): string {
		return this.selectedEndpoint.version;
	}

	get tokenizer(): TokenizerType {
		return this.selectedEndpoint.tokenizer;
	}

	processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken): Promise<AsyncIterableObject<ChatCompletion>> {
		return this.selectedEndpoint.processResponseFromChatEndpoint(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);
	}

	acceptChatPolicy(): Promise<boolean> {
		return this.selectedEndpoint.acceptChatPolicy();
	}

	makeChatRequest(debugName: string, messages: ChatMessage[], finishedCb: FinishedCallback | undefined, token: CancellationToken, location: ChatLocation, source?: Source, requestOptions?: Omit<OptionalChatRequestParams, 'n'>, userInitiatedRequest?: boolean, telemetryProperties?: TelemetryProperties, intentParams?: IntentParams): Promise<ChatResponse> {
		return this.selectedEndpoint.makeChatRequest(debugName, messages, finishedCb, token, location, source, requestOptions, userInitiatedRequest, telemetryProperties, intentParams);
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this.selectedEndpoint.cloneWithTokenOverride(modelMaxPromptTokens);
	}

	acquireTokenizer(): ITokenizer {
		return this.selectedEndpoint.acquireTokenizer();
	}
}


interface ExperimentConfig {
	selected: string;
	name: string;
	id: string;
}

export function getCustomDefaultModelExperimentConfig(expService: IExperimentationService): ExperimentConfig | undefined {
	const selected = expService.getTreatmentVariable<string>('vscode', 'custommodel1');
	const id = expService.getTreatmentVariable<string>('vscode', 'custommodel1.id');
	const name = expService.getTreatmentVariable<string>('vscode', 'custommodel1.name');
	if (selected && id && name) {
		return { selected, id, name };
	}
	return undefined;
}

export function applyExperimentModifications(
	modelMetadata: IChatModelInformation,
	experimentConfig: ExperimentConfig | undefined
): IChatModelInformation {
	const knownDefaults = ['gpt-4.1'];
	if (modelMetadata && experimentConfig && modelMetadata.is_chat_default && knownDefaults.includes(modelMetadata.id)) {
		return { ...modelMetadata, is_chat_default: false };
	}
	return modelMetadata;
}