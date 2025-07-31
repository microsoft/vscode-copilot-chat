/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { createServiceIdentifier } from '../../../util/common/services';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IChatEndpoint } from '../../networking/common/networking';
import { AutoChatEndpoint } from './autoChatEndpoint';
import { ICAPIClientService } from './capiClient';

interface AutoModeAPIResponse {
	available_models: string[];
	selected_model: string;
	session_token: string;
}

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IAutomodeService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	getCachedAutoEndpoint(conversationId: string): IChatEndpoint | undefined;

	resolveAutoModeEndpoint(conversationId: string, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint>;
}

export class AutomodeService implements IAutomodeService {
	readonly _serviceBrand: undefined;
	private readonly _autoModelCache: Map<string, IChatEndpoint> = new Map();

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authService: IAuthenticationService
	) {
		this._serviceBrand = undefined;
	}

	getCachedAutoEndpoint(conversationId: string): IChatEndpoint | undefined {
		return this._autoModelCache.get(conversationId);
	}

	async resolveAutoModeEndpoint(conversationId: string, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		if (this.getCachedAutoEndpoint(conversationId)) {
			return this.getCachedAutoEndpoint(conversationId)!;
		}
		const authToken = (await this._authService.getCopilotToken()).token;
		const response = await this._capiClientService.makeRequest<Response>({
			json: {
				"auto_mode": { "model_hints": ["auto"] },
			},
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${authToken}`
			},
			method: 'POST'
		}, { type: RequestType.AutoModels });
		const data: AutoModeAPIResponse = await response.json() as AutoModeAPIResponse;
		const selectedModel = knownEndpoints.find(e => e.model === data.selected_model) || knownEndpoints[0];
		const autoEndpoint = new AutoChatEndpoint(selectedModel, data.session_token);
		this._autoModelCache.set(conversationId, autoEndpoint);
		return autoEndpoint;
	}
}