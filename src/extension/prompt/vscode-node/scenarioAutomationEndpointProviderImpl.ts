/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatRequest, LanguageModelChat, lm } from 'vscode';
import { ChatEndpointFamily } from '../../../platform/endpoint/common/endpointProvider';
import { ExtensionContributedChatEndpoint } from '../../../platform/endpoint/vscode-node/extChatEndpoint';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ProductionEndpointProvider } from './endpointProviderImpl';

export class ScenarioAutomationEndpointProviderImpl extends ProductionEndpointProvider {
	override async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		if (this._authService.copilotToken?.isNoAuthUser) {
			// When using no auth in scenario automation, we want to force using a custom model / non-copilot for all requests
			const getFirstNonCopilotModel = async () => {
				const allModels = await lm.selectChatModels();
				const firstNonCopilotModel = allModels.find(m => m.vendor !== 'copilot');
				if (firstNonCopilotModel) {
					this._logService.trace(`Using custom contributed chat model`);
					return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, firstNonCopilotModel);
				} else {
					throw new Error('No custom contributed chat models found.');
				}
			};

			// Check if we have a hard-coded family which indicates a copilot model
			if (typeof requestOrFamilyOrModel === 'string') {
				return getFirstNonCopilotModel();
			}

			// Check if a copilot model was explicitly requested in the picker
			const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;
			if (model.vendor === 'copilot') {
				return getFirstNonCopilotModel();
			}
		}

		return super.getChatEndpoint(requestOrFamilyOrModel);
	}
}