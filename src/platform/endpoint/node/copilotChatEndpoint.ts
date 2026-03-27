/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IChatEndpoint, IMakeChatRequestOptions } from '../../networking/common/networking';
import { RawMessageConversionCallback } from '../../networking/common/openai';
import { IChatWebSocketManager } from '../../networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { ICAPIClientService } from '../common/capiClient';
import { IDomainService } from '../common/domainService';
import { ChatEndpointFamily, IChatModelInformation } from '../common/endpointProvider';
import { IModelMetadataFetcher } from './modelMetadataFetcher';
import { ChatEndpoint } from './chatEndpoint';

export class CopilotChatEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentService,
			chatWebSocketService,
			logService
		);
	}

	protected override getCompletionsCallback(): RawMessageConversionCallback | undefined {
		return (out, data) => {
			if (data && data.id) {
				out.reasoning_opaque = data.id;
				out.reasoning_text = Array.isArray(data.text) ? data.text.join('') : data.text;
			}
		};
	}
}

/**
 * Endpoint for the `copilot-fast` internal family. Prefers {@link primaryFamily} but falls back to
 * {@link fallbackFamily} when the primary model is not available to the user.
 *
 * When the primary model uses the Responses API, reasoning effort is forced to `'none'` so that
 * background tasks (title generation, rename suggestions, etc.) are fast and cheap. When the same
 * model is selected explicitly in the model picker it uses a regular {@link CopilotChatEndpoint}
 * and respects the user's chosen reasoning effort.
 */
export class CopilotFastChatEndpoint extends CopilotChatEndpoint {
	static readonly primaryFamily = 'gpt-5.4-nano';
	static readonly fallbackFamily = 'gpt-4o-mini';

	static async create(modelFetcher: IModelMetadataFetcher, instantiationService: IInstantiationService): Promise<IChatEndpoint> {
		let modelMetadata: IChatModelInformation;
		try {
			modelMetadata = await modelFetcher.getChatModelFromFamily(CopilotFastChatEndpoint.primaryFamily as ChatEndpointFamily);
		} catch {
			modelMetadata = await modelFetcher.getChatModelFromFamily(CopilotFastChatEndpoint.fallbackFamily as ChatEndpointFamily);
		}
		return instantiationService.createInstance(CopilotFastChatEndpoint, modelMetadata);
	}

	protected override async _makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken) {
		return super._makeChatRequest2(
			this.useResponsesApi ? { ...options, reasoningEffort: 'none' } : options,
			token
		);
	}
}
