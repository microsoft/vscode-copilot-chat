/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ITokenizer, TokenizerType } from '../../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IChatMLFetcher, IntentParams, Source } from '../../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../../chat/common/commonTypes';
import { CHAT_MODEL } from '../../../configuration/common/configurationService';
import { ILogService } from '../../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../networking/common/fetch';
import { Response } from '../../../networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../../networking/common/networking';
import { ChatCompletion } from '../../../networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../../telemetry/common/telemetry';
import { TelemetryData } from '../../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';

export class MockEndpoint implements IChatEndpoint {
	constructor(
		@IChatMLFetcher private readonly _chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
	) { }
	isPremium: boolean = false;
	multiplier: number = 0;
	restrictedToSkus?: string[] | undefined;

	maxOutputTokens: number = 50000;
	model: string = CHAT_MODEL.GPT41;
	supportsToolCalls: boolean = false;
	supportsVision: boolean = false;
	supportsPrediction: boolean = true;
	showInModelPicker: boolean = true;
	isDefault: boolean = false;
	isFallback: boolean = false;
	policy: 'enabled' | { terms: string } = 'enabled';
	urlOrRequestMetadata: string = 'https://microsoft.com';
	modelMaxPromptTokens: number = 50000;
	name: string = 'test';
	version: string = '1.0';
	family: string = 'test';
	vendor: string = 'copilot';
	tokenizer: TokenizerType = TokenizerType.O200K;

	processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken): Promise<AsyncIterableObject<ChatCompletion>> {
		throw new Error('Method not implemented.');
	}

	acceptChatPolicy(): Promise<boolean> {
		throw new Error('Method not implemented.');
	}

	public async makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams
	): Promise<ChatResponse> {
		return this._chatMLFetcher.fetchOne(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			this,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
			intentParams
		);
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		throw new Error('Method not implemented.');
	}

	getExtraHeaders?(): Record<string, string> {
		throw new Error('Method not implemented.');
	}

	interceptBody?(body: IEndpointBody | undefined): void {
		throw new Error('Method not implemented.');
	}

	acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer(this);
	}
}
